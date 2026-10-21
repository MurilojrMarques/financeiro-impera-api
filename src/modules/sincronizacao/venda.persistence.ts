import type { Prisma } from '../../generated/prisma/client';
import { ReferenceResolver } from '../../shared/services/references.service';
import { stableHash } from '../../shared/utils/text';
import { classificar, type RegraClassificacaoInput } from '../classificacoes/classificacao.service';
import { comissaoPorRegra, mesclarComissao, type ComissaoValor, type RegraComissaoVigente } from '../vendas/domain/comissao';
import {
  aplicarFatos,
  type Atributos,
  type EstadoVenda,
  type EventoFato,
  type Fato,
  type ResultadoVenda,
} from '../vendas/domain/venda.aggregator';
import { ehX1, type CriterioX1 } from '../vendas/domain/x1';

type Tx = Prisma.TransactionClient;

export interface ContextoPersistencia {
  regras: RegraClassificacaoInput[];
  x1: CriterioX1 | null;
  /** payout do RedTrack substitui comissão de fonte menos confiável (estimada/regra) */
  redtrackPayoutComoComissao?: boolean;
}

export interface ResumoPersistencia {
  inseridos: number;
  atualizados: number;
  ignorados: number;
}

type VendaComRelacoes = Prisma.VendaGetPayload<{ include: { eventos: true; loja: { select: { nome: true } } } }>;

export function estadoDeVenda(v: VendaComRelacoes): EstadoVenda {
  const atributos: Atributos = {
    loja: v.loja?.nome ?? null,
    produto: v.kitNome,
    afiliadoNome: v.afiliadoNomeOriginal,
    tipoBruto: v.tipoBruto,
    origem: v.origem,
    tipoAtendimento: v.tipoAtendimento,
    atendente: v.atendente,
    checkout: v.checkout,
    metodo: v.metodoPagamento,
    campanha: v.campanha,
    anuncio: v.anuncio,
    clickId: v.clickId,
    utmSource: v.utmSource,
    utmCampaign: v.utmCampaign,
    utmContent: v.utmContent,
    src: v.src,
    parcelas: v.parcelas,
    valorTotalCentavos: v.valorTotalCentavos,
    valorVendaCentavos: v.valorVendaCentavos,
    jurosCentavos: v.jurosCentavos,
    valorLiquidoCentavos: v.valorLiquidoCentavos,
    taxaCallCenterCentavos: v.taxaCallCenterCentavos,
    // só o valor EXATO volta ao estado; o derivado de regra é recalculado a cada passagem
    comissaoAfiliadoCentavos: v.comissaoAfiliadoFonte === 'HISTORICO_EXATA' ? v.comissaoAfiliadoCentavos : null,
    vendedorId: v.vendedorId,
    clienteHash: v.clienteHash,
    canalPlanilha: v.canalPlanilha,
    subcanal: v.subcanal,
    origemLead: v.origemLead,
    pagoEm: v.pagoEm,
    criadoEmOrigem: v.criadoEmOrigem,
  };
  const eventos: EventoFato[] = v.eventos.map((e) => ({
    eventKey: e.eventKey,
    tipo: e.tipo,
    fonte: e.fonte,
    ocorridoEm: e.ocorridoEm,
    recebidoEm: e.recebidoEm,
    valorCentavos: e.valorCentavos,
    comissaoCentavos: e.comissaoCentavos,
    linhaOrigem: e.linhaOrigem,
    hashConteudo: e.hashConteudo,
    // evento HISTORICO sem valor veio do status
    derivadoDeStatus: e.fonte === 'HISTORICO' && e.valorCentavos === null && e.tipo !== 'PAGAMENTO',
  }));
  return {
    atributos,
    comissao: { centavos: v.comissaoCentavos, fonte: v.comissaoFonte },
    fonteVerdade: v.fonteVerdade,
    eventos,
  };
}

export function carregarVendas(tx: Tx, pedidos: string[]): Promise<VendaComRelacoes[]> {
  return tx.venda.findMany({
    where: { pedido: { in: pedidos } },
    include: { eventos: true, loja: { select: { nome: true } } },
  });
}

/** Hash do estado final: se igual ao armazenado, nada é regravado (idempotência real). */
export function hashDoResultado(r: ResultadoVenda, grupo: string, x1: boolean, comissao: ComissaoValor, comissaoAfiliado: ComissaoValor): string {
  return stableHash({
    ...(r.atributos as unknown as Record<string, unknown>),
    comissaoAfiliadoFinal: comissaoAfiliado.centavos,
    comissaoAfiliadoFonte: comissaoAfiliado.fonte,
    status: r.status,
    perda: r.perda.perdaCentavos,
    perdaEm: r.perda.perdaEm,
    perdaTipo: r.perda.perdaTipo,
    grupo,
    x1,
    comissao: comissao.centavos,
    comissaoFonte: comissao.fonte,
    fonteVerdade: r.fonteVerdade,
    eventos: r.eventos.map((e) => `${e.eventKey}:${e.hashConteudo}:${e.ocorridoEm?.toISOString() ?? ''}`).sort(),
  });
}

/**
 * Persiste fatos agrupados por pedido: calcula estado final, classifica e faz UPSERT de vendas e eventos
 * dentro da transação do lote. Chamar sempre dentro de prisma.$transaction.
 */
export async function persistirFatos(
  tx: Tx,
  porPedido: Map<string, Fato[]>,
  existentes: Map<string, VendaComRelacoes>,
  ctx: ContextoPersistencia,
): Promise<ResumoPersistencia> {
  const resumo: ResumoPersistencia = { inseridos: 0, atualizados: 0, ignorados: 0 };

  const calculados = [...porPedido.entries()].map(([pedido, fatos]) => {
    const existente = existentes.get(pedido);
    return { pedido, existente, resultado: aplicarFatos(existente ? estadoDeVenda(existente) : null, fatos) };
  });

  const refs = new ReferenceResolver(tx);
  await refs.preload({
    lojas: calculados.map((c) => c.resultado.atributos.loja),
    produtos: calculados.map((c) => c.resultado.atributos.produto),
    afiliados: calculados.map((c) => c.resultado.atributos.afiliadoNome),
  });

  // regras de comissão de afiliado (vigência) — só para os afiliados deste lote
  const afiliadoIds = [...new Set(calculados.map((c) => refs.afiliado(c.resultado.atributos.afiliadoNome)).filter((x): x is string => !!x))];
  const regrasComissao = afiliadoIds.length
    ? await tx.regraComissaoAfiliado.findMany({ where: { afiliadoId: { in: afiliadoIds } } })
    : [];
  const regrasPorAfiliado = new Map<string, RegraComissaoVigente[]>();
  regrasComissao.forEach((r) => regrasPorAfiliado.set(r.afiliadoId, [...(regrasPorAfiliado.get(r.afiliadoId) ?? []), r]));

  const redtracks = new Map(
    (await tx.redtrackConversao.findMany({
      where: { pedido: { in: calculados.map((c) => c.pedido) } },
      select: { pedido: true, campanha: true, anuncio: true, payoutCentavos: true },
    })).map((r) => [r.pedido, r]),
  );

  for (const { pedido, existente, resultado } of calculados) {
    const a = resultado.atributos;
    const rt = redtracks.get(pedido);
    // RedTrack só completa campanha/anúncio quando a origem principal não informou
    if (rt) {
      a.campanha ??= rt.campanha;
      a.anuncio ??= rt.anuncio;
    }
    if (a.valorVendaCentavos === null) {
      resumo.ignorados++;
      continue;
    }
    const afiliadoId = refs.afiliado(a.afiliadoNome);
    const cls = classificar(
      {
        afiliadoNome: a.afiliadoNome,
        tipoBruto: a.tipoBruto,
        kitNome: a.produto,
        origem: a.origem,
        tipoAtendimento: a.tipoAtendimento,
        loja: a.loja,
        campanha: a.campanha,
        utmSource: a.utmSource,
        src: a.src,
        checkout: a.checkout,
        canalPlanilha: a.canalPlanilha,
        subcanal: a.subcanal,
      },
      ctx.regras,
    );

    // Comissão da OPERAÇÃO (o que a Impera recebe): histórico > Pagah > payout RedTrack > estimada.
    let comissao = resultado.comissao;
    if (ctx.redtrackPayoutComoComissao && rt?.payoutCentavos != null) {
      comissao = mesclarComissao(comissao, { centavos: rt.payoutCentavos, fonte: 'REDTRACK' });
    }

    // Comissão do AFILIADO (campo distinto): valor exato da fonte (HISTORICO) ou, na falta, regra configurada com vigência.
    let comissaoAfiliado: ComissaoValor = { centavos: null, fonte: 'AUSENTE' };
    if (a.comissaoAfiliadoCentavos !== null) {
      comissaoAfiliado = { centavos: a.comissaoAfiliadoCentavos, fonte: 'HISTORICO_EXATA' };
    } else if (afiliadoId) {
      const porRegra = comissaoPorRegra(a.valorVendaCentavos, a.pagoEm, regrasPorAfiliado.get(afiliadoId) ?? []);
      if (porRegra !== null) comissaoAfiliado = { centavos: porRegra, fonte: 'REGRA_AFILIADO' };
    }

    const x1 = ehX1(a, ctx.x1);
    const hash = hashDoResultado(resultado, cls.grupo, x1, comissao, comissaoAfiliado);
    if (existente && existente.hashConteudo === hash) {
      resumo.ignorados++;
      continue;
    }

    const data = {
      lojaId: refs.loja(a.loja),
      produtoId: refs.produto(a.produto),
      afiliadoId,
      afiliadoNomeOriginal: a.afiliadoNome,
      grupo: cls.grupo,
      tipoVenda: cls.tipoVenda,
      tipoBruto: a.tipoBruto,
      status: resultado.status,
      origem: a.origem,
      tipoAtendimento: a.tipoAtendimento,
      atendente: a.atendente,
      checkout: a.checkout,
      kitNome: a.produto,
      metodoPagamento: a.metodo,
      parcelas: a.parcelas,
      valorTotalCentavos: a.valorTotalCentavos,
      valorVendaCentavos: a.valorVendaCentavos,
      jurosCentavos: a.jurosCentavos,
      valorLiquidoCentavos: a.valorLiquidoCentavos,
      comissaoCentavos: comissao.centavos,
      comissaoFonte: comissao.fonte,
      taxaCallCenterCentavos: a.taxaCallCenterCentavos,
      comissaoAfiliadoCentavos: comissaoAfiliado.centavos,
      comissaoAfiliadoFonte: comissaoAfiliado.fonte,
      vendedorId: a.vendedorId,
      clienteHash: a.clienteHash,
      canalPlanilha: a.canalPlanilha,
      subcanal: a.subcanal,
      origemLead: a.origemLead,
      x1,
      campanha: a.campanha,
      anuncio: a.anuncio,
      clickId: a.clickId,
      utmSource: a.utmSource,
      utmCampaign: a.utmCampaign,
      utmContent: a.utmContent,
      src: a.src,
      pagoEm: a.pagoEm,
      criadoEmOrigem: a.criadoEmOrigem,
      estornadoEm: resultado.perda.estornadoEm,
      chargebackEm: resultado.perda.chargebackEm,
      perdaCentavos: resultado.perda.perdaCentavos,
      perdaEm: resultado.perda.perdaEm,
      perdaTipo: resultado.perda.perdaTipo,
      classificacaoMotivo: cls.motivo,
      classificacaoRegraId: cls.regraId,
      avisos: resultado.avisos,
      redtrackConciliado: !!rt,
      fonteVerdade: resultado.fonteVerdade,
      hashConteudo: hash,
      sincronizadoEm: new Date(),
    } satisfies Prisma.VendaUncheckedUpdateInput;

    const venda = await tx.venda.upsert({
      where: { pedido },
      create: { pedido, ...data },
      update: data,
      select: { id: true },
    });
    if (existente) resumo.atualizados++;
    else resumo.inseridos++;
    if (rt) await tx.redtrackConversao.updateMany({ where: { pedido, vendaId: null }, data: { vendaId: venda.id } });

    const hashesExistentes = new Map((existente?.eventos ?? []).map((e) => [e.eventKey, e.hashConteudo]));
    for (const ev of resultado.eventos) {
      if (hashesExistentes.get(ev.eventKey) === ev.hashConteudo && existente) continue;
      const evData = {
        tipo: ev.tipo,
        fonte: ev.fonte,
        ocorridoEm: ev.ocorridoEm,
        recebidoEm: ev.recebidoEm,
        valorCentavos: ev.valorCentavos,
        comissaoCentavos: ev.comissaoCentavos,
        linhaOrigem: ev.linhaOrigem,
        hashConteudo: ev.hashConteudo,
      };
      await tx.vendaEvento.upsert({
        where: { eventKey: ev.eventKey },
        create: { vendaId: venda.id, eventKey: ev.eventKey, ...evData },
        update: evData,
      });
    }
  }
  return resumo;
}
