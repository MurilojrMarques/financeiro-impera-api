import { prisma } from '../../config/database';
import { comissaoCopyNoPeriodo, type ComissaoCopy } from '../../integrations/copy-supabase/copy-comissao';
import { relatorioPorLanding } from '../../integrations/redtrack/redtrack.landing';
import { limitesDoMes } from '../rh/rh.service';
import { linhasPorVsl, type LinhaVsl } from './vsl.domain';

/**
 * Comissão do time do Front por pessoa, fechada contra a folha de setembro/2026 (decisões do Elias de 01/10 + regras da folha):
 *  - Copywriter: 5% do MC BR dos criativos que fez (Elias 7,5%) + 5% do MC BR das VSLs de que é dono (Elias 7,5%) + R$ 500 por otimização validada.
 *    O negativo de um bloco abate os outros; o piso em 0 é no total da pessoa. Desligado não recebe, mas o MC dele segue nas bases de terceiros.
 *  - Elias (liderança): + 2% do MC BR (criativos + VSL) dos outros copys, sem ele, o Douglas e a Empresa.
 *  - Editor (Mineiro): 1% do MC BR das VSLs que editou (1ª versão). Iago: 2,5% do MC BR total (Pagah). Gestor de tráfego: 5% do MC BR das campanhas dele.
 *  - O que não bate com a folha (Lucas, João) fica EM_IMPLEMENTACAO e não entra em total nem em lançamento. A lista só traz quem tem valor a pagar.
 * O MC BR dos criativos vem do sistema de copy (autoria); o das VSLs, do gestor e o total vêm do RedTrack por landing (mesmo MC BR da planilha).
 */
export const INICIO_REGRA_COMPLETA = '2026-09';
const PCT_PADRAO = 0.05;
const PCT_ELIAS = 0.075;
const PCT_LIDERANCA = 0.02;
const PCT_EDITOR = 0.01;
const PCT_FIXO_IAGO = 0.025;
const PCT_GESTOR = 0.05;
export const VALOR_OTIMIZACAO_CENTAVOS = 50_000;
/** fora da base dos 2% do Elias: ele mesmo, o Douglas (CEO) e a Empresa (página sem copy) */
const FORA_DA_LIDERANCA = new Set(['ELIAS', 'DOUGLAS', 'EMPRESA']);

export type TipoBeneficiario = 'COPYWRITER' | 'GESTOR' | 'EDITOR' | 'FIXO';

export interface BeneficiarioComissao {
  /** uuid do copywriter no copy, ou GESTOR:GREG / EDITOR:MINEIRO / FIXO:IAGO */
  chave: string;
  tipo: TipoBeneficiario;
  nome: string;
  status: 'CALCULADA' | 'EM_IMPLEMENTACAO';
  motivo: string | null;
  ativo: boolean;
  regra: string;
  /** MC BR da base principal da pessoa (criativos; no editor/gestor, o das VSLs/campanhas dele) */
  mcBrCentavos: number | null;
  criativosCentavos: number | null;
  vslCentavos: number | null;
  otimizacoesCentavos: number | null;
  /** liderança (Elias), editor, gestor ou o fixo do Iago */
  outrosCentavos: number | null;
  outrosRotulo: string | null;
  /** soma dos blocos, com os negativos */
  apuradaCentavos: number | null;
  /** o que se paga: piso em 0 no total, e 0 para desligado */
  aPagarCentavos: number | null;
}

export interface VslCadastro {
  chave: string;
  dono: string | null;
  editor: string | null;
  mesmaVsl: string | null;
}

export interface EntradaApuracao {
  copy: Extract<ComissaoCopy, { disponivel: true }>;
  /** null = fora do período da regra completa (só criativos) ou RedTrack indisponível */
  vsl: { linhas: LinhaVsl[]; cadastro: VslCadastro[] } | null;
  otimizacoes: { copywriter: string; valorCentavos: number }[];
  /** ids de copywriters ligados a um colaborador do RH com data de demissão: não recebem */
  desligados?: ReadonlySet<string>;
  completa: boolean;
}

export interface ApuracaoFront {
  itens: BeneficiarioComissao[];
  /** VSLs com MC BR no período e sem dono no cadastro: o dinheiro delas não chega a ninguém até o RH cadastrar */
  vslSemDono: { vsl: string; mcBrCentavos: number }[];
  totais: { apuradaCentavos: number; aPagarCentavos: number };
}

export const norm = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().trim();
const cent = (reais: number): number => Math.round(reais * 100);
const soma = (m: Map<string, number>, k: string, v: number): void => void m.set(k, (m.get(k) ?? 0) + v);

const OUTROS: { chave: string; tipo: TipoBeneficiario; nome: string; regra: string }[] = [
  { chave: 'EDITOR:MINEIRO', tipo: 'EDITOR', nome: 'Igor Paiva (Mineiro)', regra: '1% do MC BR das VSLs que editou (1ª versão)' },
  { chave: 'FIXO:IAGO', tipo: 'FIXO', nome: 'Iago', regra: '2,5% do MC BR total (Pagah)' },
  { chave: 'GESTOR:GREG', tipo: 'GESTOR', nome: 'Greg', regra: '5% do MC BR das campanhas dele' },
];

/** a folha paga a mais que a planilha e a campanha que trocou de gestor em 09/09 ainda não está no cálculo */
const EM_IMPLEMENTACAO: { chave: string; nome: string; regra: string; motivo: string }[] = [
  { chave: 'GESTOR:LUCAS', nome: 'Lucas', regra: '5% do MC BR das campanhas dele', motivo: 'Não bate com a folha (+R$ 3.690,88 em setembro) e falta a troca de gestor de 09/09.' },
  { chave: 'GESTOR:JOAO', nome: 'João Pedro', regra: '5% do MC BR das campanhas dele', motivo: 'Não bate com a folha (+R$ 2.200,01 em setembro) e falta a troca de gestor de 09/09.' },
];

export function apurar(e: EntradaApuracao): ApuracaoFront {
  const { copy } = e;
  const vslOk = e.completa && e.vsl !== null;
  const cadastro = new Map((e.vsl?.cadastro ?? []).map((c) => [c.chave, c]));

  // MC BR (em reais) por VSL, dono, editor, gestor e o total
  const porVsl = new Map<string, number>();
  const porDono = new Map<string, number>();
  const porEditor = new Map<string, number>();
  const porGestor = new Map<string, number>();
  let total = 0;
  for (const l of e.vsl?.linhas ?? []) {
    soma(porVsl, l.vsl, l.mc);
    soma(porGestor, norm(l.gestor), l.mc);
    total += l.mc;
  }
  const vslSemDono: ApuracaoFront['vslSemDono'] = [];
  for (const [vsl, mc] of porVsl) {
    const c = cadastro.get(vsl);
    if (!c?.dono) {
      if (Math.abs(mc) >= 0.005) vslSemDono.push({ vsl, mcBrCentavos: cent(mc) });
      continue;
    }
    soma(porDono, norm(c.dono), mc);
    if (c.editor) soma(porEditor, norm(c.editor), mc);
  }
  vslSemDono.sort((a, b) => b.mcBrCentavos - a.mcBrCentavos);

  const otim = new Map<string, number>();
  for (const o of e.otimizacoes) soma(otim, norm(o.copywriter), o.valorCentavos);

  // base dos 2% do Elias: criativos + VSL dos outros copys (negativos entram; desligados também)
  let baseLiderancaReais = 0;
  for (const p of copy.pessoas) if (!FORA_DA_LIDERANCA.has(norm(p.nome))) baseLiderancaReais += p.mcBrCentavos / 100;
  for (const [dono, mc] of porDono) if (!FORA_DA_LIDERANCA.has(dono)) baseLiderancaReais += mc;

  const itens: BeneficiarioComissao[] = [];
  const porId = new Map(copy.pessoas.map((p) => [p.copywriterId, p]));
  for (const cw of copy.copywriters) {
    if (!cw.comissionavel) continue;
    const nome = norm(cw.nome);
    const p = porId.get(cw.id);
    const mcCriativos = p?.mcBrCentavos ?? 0;
    const mcVsl = vslOk ? cent(porDono.get(nome) ?? 0) : 0;
    const opt = e.completa ? (otim.get(nome) ?? 0) : 0;
    const lider = e.completa && vslOk && nome === 'ELIAS' ? cent(baseLiderancaReais * PCT_LIDERANCA) : 0;
    if (mcCriativos === 0 && mcVsl === 0 && opt === 0 && lider === 0 && !p) continue;
    const pct = nome === 'ELIAS' ? PCT_ELIAS : PCT_PADRAO;
    const criativos = e.completa ? Math.round((p?.mcBrExatoReais ?? 0) * 100 * pct) : (p?.comissaoCentavos ?? 0);
    const vslCom = Math.round(mcVsl * pct);
    const apurada = criativos + vslCom + opt + lider;
    const ativo = cw.ativo && !e.desligados?.has(cw.id);
    itens.push({
      chave: cw.id,
      tipo: 'COPYWRITER',
      nome: cw.nome,
      status: 'CALCULADA',
      motivo: ativo ? null : 'Desligado: não recebe a comissão (o MC BR dele segue na base do Elias).',
      ativo,
      regra: e.completa ? `${pct * 100}% criativos + ${pct * 100}% VSL + R$ 500 por otimização${nome === 'ELIAS' ? ' + 2% do MC dos outros copys' : ''}` : '5% do MC BR dos criativos',
      mcBrCentavos: mcCriativos,
      criativosCentavos: criativos,
      vslCentavos: e.completa ? vslCom : null,
      otimizacoesCentavos: e.completa ? opt : null,
      outrosCentavos: nome === 'ELIAS' && e.completa ? lider : null,
      outrosRotulo: nome === 'ELIAS' && e.completa ? 'Liderança (2%)' : null,
      apuradaCentavos: apurada,
      aPagarCentavos: ativo ? Math.max(0, apurada) : 0,
    });
  }

  if (vslOk) {
    for (const o of OUTROS) {
      const base = o.tipo === 'EDITOR' ? (porEditor.get('MINEIRO') ?? 0) : o.tipo === 'GESTOR' ? (porGestor.get(norm(o.chave.split(':')[1]!)) ?? 0) : total;
      const pct = o.tipo === 'EDITOR' ? PCT_EDITOR : o.tipo === 'GESTOR' ? PCT_GESTOR : PCT_FIXO_IAGO;
      const com = cent(base * pct);
      itens.push({
        chave: o.chave, tipo: o.tipo, nome: o.nome, status: 'CALCULADA', motivo: null, ativo: true, regra: o.regra,
        mcBrCentavos: cent(base), criativosCentavos: null, vslCentavos: null, otimizacoesCentavos: null,
        outrosCentavos: com, outrosRotulo: o.regra, apuradaCentavos: com, aPagarCentavos: Math.max(0, com),
      });
    }
    for (const o of EM_IMPLEMENTACAO) {
      itens.push({
        chave: o.chave, tipo: 'GESTOR', nome: o.nome, status: 'EM_IMPLEMENTACAO', motivo: o.motivo, ativo: true, regra: o.regra,
        mcBrCentavos: null, criativosCentavos: null, vslCentavos: null, otimizacoesCentavos: null, outrosCentavos: null, outrosRotulo: null,
        apuradaCentavos: null, aPagarCentavos: null,
      });
    }
  }

  const calculadas = itens.filter((i) => i.status === 'CALCULADA');
  // só aparece quem tem valor a pagar (negativo, zero e desligado ficam fora) e o que está em implementação; as bases de terceiros já foram somadas acima
  const visiveis = itens.filter((i) => i.status === 'EM_IMPLEMENTACAO' || (i.aPagarCentavos ?? 0) > 0);
  visiveis.sort((a, b) => (b.aPagarCentavos ?? -1) - (a.aPagarCentavos ?? -1) || a.nome.localeCompare(b.nome));
  return {
    itens: visiveis,
    vslSemDono,
    totais: { apuradaCentavos: calculadas.reduce((s, i) => s + (i.apuradaCentavos ?? 0), 0), aPagarCentavos: calculadas.reduce((s, i) => s + (i.aPagarCentavos ?? 0), 0) },
  };
}

const dia = (d: Date): string => d.toISOString().slice(0, 10);

export type ResultadoApuracaoFront =
  | ({ disponivel: true; estado: 'FECHADO' | 'PROVISORIO'; completa: boolean; vslDisponivel: boolean; vslMensagem: string | null } & ApuracaoFront)
  | { disponivel: false; motivo: string; mensagem: string };

/** Carrega as fontes (copy, RedTrack por landing, cadastro de VSL e otimizações) e apura o mês. */
export async function apurarFront(competencia: string): Promise<ResultadoApuracaoFront> {
  const { inicio, fim } = limitesDoMes(competencia);
  const copy = await comissaoCopyNoPeriodo(dia(inicio), dia(fim));
  if (!copy.disponivel) return { disponivel: false, motivo: copy.motivo, mensagem: copy.mensagem };

  const completa = competencia >= INICIO_REGRA_COMPLETA;
  let vsl: EntradaApuracao['vsl'] = null;
  let vslMensagem: string | null = null;
  if (completa) {
    const [rel, cadastro] = await Promise.all([relatorioPorLanding(dia(inicio), dia(fim)), prisma.comissaoVsl.findMany({ select: { chave: true, dono: true, editor: true, mesmaVsl: true } })]);
    if (rel.ok) {
      const mesma = Object.fromEntries(cadastro.filter((c) => c.mesmaVsl).map((c) => [c.chave, c.mesmaVsl!]));
      vsl = { linhas: linhasPorVsl(rel.linhas, 'Pagah', mesma), cadastro };
    } else {
      vslMensagem = rel.mensagem;
    }
  }
  const otimizacoes = completa ? await prisma.comissaoOtimizacao.findMany({ where: { competencia }, select: { copywriter: true, valorCentavos: true } }) : [];
  const deslig = await prisma.rhColaborador.findMany({ where: { copywriterId: { not: null }, demissao: { not: null } }, select: { copywriterId: true } });
  const r = apurar({ copy, vsl, otimizacoes, completa, desligados: new Set(deslig.map((d) => d.copywriterId!)) });
  return { disponivel: true, estado: copy.estado, completa, vslDisponivel: !completa || vsl !== null, vslMensagem, ...r };
}
