import { describe, expect, it } from 'vitest';
import type { ComissaoCopyPessoa, CopywriterDoCopy } from '../../src/integrations/copy-supabase/copy-comissao';
import { apurar, type EntradaApuracao } from '../../src/modules/comissoes/comissao-front';
import type { LinhaVsl } from '../../src/modules/comissoes/vsl.domain';

/** MC BR dos criativos de setembro/2026 por copywriter (aba "CRIATIVOS SETEMBRO - COPYWRITER") */
const CRIATIVOS: Record<string, number> = {
  YAN: 291937.1137, DARLYSSON: 23202.89627, CAROL: 16554.39875, REAPER: 15968.99386, ELIAS: 2101.36858, ANA: -934.57174,
  VINICIUS: -5120.69512, CRISPIM: -10876.05983, BRUNO: -15246.84394, DOUGLAS: -18825.80058,
};
const id = (n: string): string => `00000000-0000-4000-8000-${String([...n].reduce((s, c) => s + c.charCodeAt(0), 0)).padStart(12, '0')}`;
const copywriters: CopywriterDoCopy[] = [...Object.keys(CRIATIVOS), 'EMPRESA'].map((nome) => ({ id: id(nome), nome, comissionavel: nome !== 'EMPRESA', ativo: nome !== 'ANA' }));
const pessoas: ComissaoCopyPessoa[] = Object.entries(CRIATIVOS).map(([nome, mc]) => ({
  copywriterId: id(nome), nome, mcBrCentavos: Math.round(mc * 100), mcBrExatoReais: mc, comissaoCentavos: Math.round(mc * 5), aPagarCentavos: Math.max(0, Math.round(mc * 5)), ativo: nome !== 'ANA',
}));

/** VSLs de setembro: MC BR por dono (aba "VSL SETEMBRO - COMISSÃO COPY"); a VSL do Yan divide-se entre Lucas e Greg, e as do Elias entre editores */
const l = (vsl: string, mc: number, gestor = 'LUCAS'): LinhaVsl => ({ vsl, gestor, mc, cost: 0, rev: 0 });
const linhas: LinhaVsl[] = [
  l('NE OF04 NERVE PURE', 208855.96348), l('NE OF04 NERVE PURE', 37106.72382, 'GREG'),
  l('DA OF04 ARTIPURE', 10654.0472), l('DA OF03 ARTICURE VSL03', 51706.0686),
  l('DB OFC09 GLICO DROPS', 3830.51724, 'DOUGLAS'), l('MM OF03 MEMO KARE', -2345.41574), l('PT OF04 PROSTASAFE VSL01', -11047.10281), l('NE SEM LANDING', -3610.85197, 'WANDERSON'),
];
const cadastro = [
  { chave: 'NE OF04 NERVE PURE', dono: 'YAN', editor: 'MINEIRO', mesmaVsl: null },
  { chave: 'DA OF04 ARTIPURE', dono: 'ELIAS', editor: 'MINEIRO', mesmaVsl: null },
  { chave: 'DA OF03 ARTICURE VSL03', dono: 'ELIAS', editor: 'RIPAGEM', mesmaVsl: null },
  { chave: 'DB OFC09 GLICO DROPS', dono: 'DOUGLAS', editor: 'RIPAGEM', mesmaVsl: null },
  { chave: 'MM OF03 MEMO KARE', dono: 'CAROL', editor: 'VINICIUS EDITOR', mesmaVsl: null },
  { chave: 'PT OF04 PROSTASAFE VSL01', dono: 'VINICIUS', editor: 'PANTOJA', mesmaVsl: null },
  { chave: 'NE SEM LANDING', dono: 'EMPRESA', editor: null, mesmaVsl: null },
];
const entrada = (o: Partial<EntradaApuracao> = {}): EntradaApuracao => ({
  copy: { disponivel: true, comissaoCentavos: 0, aPagarCentavos: 0, mcBrComissionavelCentavos: 0, mcBrSemComissaoCentavos: 0, estado: 'FECHADO', pessoas, copywriters },
  vsl: { linhas, cadastro },
  otimizacoes: [{ copywriter: 'YAN', valorCentavos: 50000 }, { copywriter: 'CAROL', valorCentavos: 50000 }],
  desligados: new Set([id('REAPER')]),
  completa: true,
  ...o,
});
const de = (r: ReturnType<typeof apurar>, nome: string) => r.itens.find((i) => i.nome === nome)!;

describe('apuração do Front: setembro/2026 contra a folha', () => {
  const r = apurar(entrada());

  it('Yan: 5% criativos + 5% VSL + R$ 500 de otimização = R$ 27.394,99', () => {
    expect(de(r, 'YAN')).toMatchObject({ criativosCentavos: 1459686, vslCentavos: 1229813, otimizacoesCentavos: 50000, apuradaCentavos: 2739499, aPagarCentavos: 2739499 });
  });

  it('Carol: a VSL negativa abate o resto (R$ 827,72 − R$ 117,27 + R$ 500 = R$ 1.210,45)', () => {
    expect(de(r, 'CAROL')).toMatchObject({ criativosCentavos: 82772, vslCentavos: -11727, otimizacoesCentavos: 50000, aPagarCentavos: 121045 });
  });

  it('Elias: 7,5% criativos + 7,5% VSL + 2% do MC dos outros copys (sem ele, o Douglas e a Empresa)', () => {
    expect(de(r, 'ELIAS')).toMatchObject({ criativosCentavos: 15760, vslCentavos: 467701, outrosCentavos: 1096111, aPagarCentavos: 1579572 });
  });

  it('Darlysson sem VSL: 5% do MC exato (não perde o centavo do arredondamento)', () => {
    expect(de(r, 'DARLYSSON').aPagarCentavos).toBe(116014);
  });

  it('Mineiro 1% das VSLs que editou, Iago 2,5% do MC BR total, Greg 5% das campanhas dele', () => {
    expect(de(r, 'Igor Paiva (Mineiro)').aPagarCentavos).toBe(256617);
    expect(de(r, 'Iago').aPagarCentavos).toBe(737875);
    expect(de(r, 'Greg').aPagarCentavos).toBe(185534);
  });

  it('só aparece quem tem valor a pagar: desligado (copy inativo ou colaborador demitido), negativo e zero ficam fora', () => {
    const nomes = r.itens.map((i) => i.nome);
    for (const fora of ['REAPER', 'ANA', 'DOUGLAS', 'VINICIUS', 'BRUNO', 'CRISPIM']) expect(nomes).not.toContain(fora);
    expect(r.itens.filter((i) => i.status === 'CALCULADA').every((i) => (i.aPagarCentavos ?? 0) > 0)).toBe(true);
    expect(nomes).toEqual(['YAN', 'ELIAS', 'Iago', 'Igor Paiva (Mineiro)', 'Greg', 'CAROL', 'DARLYSSON', 'João Pedro', 'Lucas'].sort((a, b) => nomes.indexOf(a) - nomes.indexOf(b)));
  });

  it('o MC BR de quem ficou fora continua na base dos 2% do Elias (desligados e negativos entram)', () => {
    expect(de(r, 'ELIAS').outrosCentavos).toBe(1096111);
  });

  it('o que não bate com a folha (Lucas, João) fica em implementação e fora do total', () => {
    expect(de(r, 'Lucas')).toMatchObject({ status: 'EM_IMPLEMENTACAO', aPagarCentavos: null });
    expect(de(r, 'João Pedro').status).toBe('EM_IMPLEMENTACAO');
    expect(r.totais.aPagarCentavos).toBe(r.itens.filter((i) => i.status === 'CALCULADA').reduce((s, i) => s + (i.aPagarCentavos ?? 0), 0));
    expect(r.vslSemDono).toEqual([]);
  });
});

describe('apuração do Front: bordas', () => {
  it('VSL sem dono no cadastro aparece na lista e o dinheiro dela não vai para ninguém', () => {
    const r = apurar(entrada({ vsl: { linhas: [...linhas, l('NE OF99 PRODUTO NOVO', 1234.56)], cadastro } }));
    expect(r.vslSemDono).toEqual([{ vsl: 'NE OF99 PRODUTO NOVO', mcBrCentavos: 123456 }]);
  });

  it('antes da regra completa (competência < 2026-09): só o 5% dos criativos, sem VSL, otimização, liderança nem outras pessoas', () => {
    const r = apurar(entrada({ completa: false, vsl: null }));
    expect(r.itens.every((i) => i.tipo === 'COPYWRITER')).toBe(true);
    expect(de(r, 'YAN')).toMatchObject({ criativosCentavos: 1459686, vslCentavos: null, otimizacoesCentavos: null });
    expect(de(r, 'ELIAS').outrosCentavos).toBeNull();
  });

  it('RedTrack indisponível no mês da regra completa: sem VSL e sem as pessoas que dependem dele (o lançamento é barrado na rota)', () => {
    const r = apurar(entrada({ vsl: null }));
    expect(r.itens.some((i) => i.tipo !== 'COPYWRITER')).toBe(false);
    expect(de(r, 'ELIAS').outrosCentavos).toBe(0);
  });
});
