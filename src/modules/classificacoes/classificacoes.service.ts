import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import type { CampoClassificacao, OperadorClassificacao, TipoGrupo } from '../../generated/prisma/client';
import { sanitizeError } from '../../shared/utils/text';
import { classificar, type RegraClassificacaoInput } from './classificacao.service';

const select = {
  id: true, nome: true, campo: true, operador: true, valor: true, grupo: true, canal: true, prioridade: true, ativa: true, versao: true, criadoEm: true, atualizadoEm: true,
} as const;

export const listarRegras = () => prisma.regraClassificacao.findMany({ select, orderBy: [{ prioridade: 'asc' }, { criadoEm: 'asc' }] });

type VendaParaClassificar = {
  id: string; grupo: TipoGrupo; tipoVenda: string; classificacaoMotivo: string | null; classificacaoRegraId: string | null;
  afiliadoNomeOriginal: string | null; tipoBruto: string | null; kitNome: string | null; origem: string | null; tipoAtendimento: string | null;
  campanha: string | null; utmSource: string | null; src: string | null; checkout: string | null; canalPlanilha: string | null; subcanal: string | null; loja: { nome: string } | null;
};

const vendaSelect = {
  id: true, grupo: true, tipoVenda: true, classificacaoMotivo: true, classificacaoRegraId: true, afiliadoNomeOriginal: true,
  tipoBruto: true, kitNome: true, origem: true, tipoAtendimento: true, campanha: true, utmSource: true, src: true, checkout: true, canalPlanilha: true, subcanal: true,
  loja: { select: { nome: true } },
} as const;

const entrada = (v: VendaParaClassificar) => ({
  afiliadoNome: v.afiliadoNomeOriginal, tipoBruto: v.tipoBruto, kitNome: v.kitNome, origem: v.origem, tipoAtendimento: v.tipoAtendimento,
  loja: v.loja?.nome ?? null, campanha: v.campanha, utmSource: v.utmSource, src: v.src, checkout: v.checkout,
  canalPlanilha: v.canalPlanilha, subcanal: v.subcanal,
});

export interface RegraCandidata {
  campo: CampoClassificacao;
  operador: OperadorClassificacao;
  valor: string;
  grupo: TipoGrupo;
  prioridade: number;
}

/** Simula uma regra contra vendas existentes. NÃO escreve no banco. */
export async function simularRegra(candidata: RegraCandidata, opts: { substituirRegraId?: string; limite: number }) {
  const ativas = (await prisma.regraClassificacao.findMany({ where: { ativa: true } })).filter((r) => r.id !== opts.substituirRegraId);
  const simulada: RegraClassificacaoInput = { id: 'simulada', versao: 0, ...candidata };
  const antes: RegraClassificacaoInput[] = ativas;
  const depois: RegraClassificacaoInput[] = [...ativas, simulada];

  let analisadas = 0;
  let casadas = 0;
  let mudariam = 0;
  let receitaAfetada = 0;
  const transicoes = new Map<string, number>();
  const exemplos: { pedido: string; de: TipoGrupo; para: TipoGrupo }[] = [];
  let cursor: string | undefined;

  while (analisadas < opts.limite) {
    const lote = await prisma.venda.findMany({
      select: { ...vendaSelect, pedido: true, valorVendaCentavos: true },
      orderBy: { id: 'asc' },
      take: Math.min(500, opts.limite - analisadas),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (lote.length === 0) break;
    for (const v of lote) {
      analisadas++;
      const novo = classificar(entrada(v), depois);
      const velho = classificar(entrada(v), antes);
      if (novo.regraId === 'simulada') casadas++;
      if (novo.grupo !== velho.grupo) {
        mudariam++;
        receitaAfetada += v.valorVendaCentavos;
        const k = `${velho.grupo}->${novo.grupo}`;
        transicoes.set(k, (transicoes.get(k) ?? 0) + 1);
        if (exemplos.length < 20) exemplos.push({ pedido: v.pedido, de: velho.grupo, para: novo.grupo });
      }
    }
    cursor = lote[lote.length - 1].id;
  }
  return {
    vendasAnalisadas: analisadas,
    vendasQueCasam: casadas,
    vendasQueMudariamDeGrupo: mudariam,
    valorVendaAfetadoCentavos: receitaAfetada,
    transicoes: [...transicoes.entries()].map(([transicao, quantidade]) => ({ transicao, quantidade })),
    exemplos,
    observacao: 'Simulação somente leitura: nada foi alterado.',
  };
}

let reclassificando = false;

/** Reaplica as regras ativas a todas as vendas (em lotes). Executado fora da requisição HTTP. */
export async function reclassificarTodas(): Promise<number> {
  if (reclassificando) return 0;
  reclassificando = true;
  let alteradas = 0;
  try {
    const regras = await prisma.regraClassificacao.findMany({ where: { ativa: true } });
    let cursor: string | undefined;
    for (;;) {
      const lote = await prisma.venda.findMany({
        select: vendaSelect, orderBy: { id: 'asc' }, take: 500, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (lote.length === 0) break;
      for (const v of lote) {
        const r = classificar(entrada(v), regras);
        if (r.grupo !== v.grupo || r.tipoVenda !== v.tipoVenda || r.regraId !== v.classificacaoRegraId || r.motivo !== v.classificacaoMotivo) {
          await prisma.venda.update({
            where: { id: v.id },
            data: { grupo: r.grupo, tipoVenda: r.tipoVenda, classificacaoRegraId: r.regraId, classificacaoMotivo: r.motivo },
          });
          alteradas++;
        }
      }
      cursor = lote[lote.length - 1].id;
    }
    return alteradas;
  } finally {
    reclassificando = false;
  }
}

/** Dispara a reclassificação sem bloquear a resposta HTTP. */
export function reclassificarEmSegundoPlano(): void {
  setImmediate(() => {
    reclassificarTodas()
      .then((n) => logger.info({ alteradas: n }, 'reclassificação concluída'))
      .catch((err) => logger.error({ msg: sanitizeError(err) }, 'reclassificação falhou'));
  });
}
