import { beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ REDTRACK_API_KEY: 'chave-de-teste' as string | undefined, REDTRACK_BASE_URL: 'https://rt.example', REDTRACK_OFFER_FILTER: 'pagah', REDTRACK_TIMEOUT_MS: 1000, NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
vi.mock('../../src/config/env', () => ({ env: envMock }));

import { investimentoNoPeriodo, limparCacheRedtrack, somarCusto, somarRedtrack, type Fetcher } from '../../src/integrations/redtrack/redtrack.client';
import { PARAMETROS_PADRAO, custoUnitarioDoKit, mcBrCentavos, montarResumo, montarResumoCallCenter, unidadesDoKit } from '../../src/modules/trafego/trafego.domain';

describe('unidades por kit', () => {
  it.each([
    ['6 Nervepure - $397', 6, true],
    ['10 NeuroSilence - $597', 10, true],
    ['NeuroSilence Gotas - 5 Frascos', 5, true],
    ['NeuroSilence Gotas 1 Frasco (teste)', 1, true],
    ['(upsell) 3 Erevita - $197', 3, true],
    ['(Upsell) - 3 Gelatina Fit - 197', 3, true],
    ['(upsell) - Plano 6 meses - R$ 405,90', 1, false],
    [null, 1, false],
  ])('%s => %i un.', (nome, un, det) => {
    expect(unidadesDoKit(nome as string | null)).toEqual({ unidades: un, detectado: det });
  });

  it('custo unitário: gelatina R$ 9,90; demais R$ 6,10 (sem acento/caixa)', () => {
    expect(custoUnitarioDoKit('5 Gelatina Max - $485', PARAMETROS_PADRAO)).toBe(990);
    expect(custoUnitarioDoKit('6 GELATINA Fit', PARAMETROS_PADRAO)).toBe(990);
    expect(custoUnitarioDoKit('6 Nervepure', PARAMETROS_PADRAO)).toBe(610);
  });
});

describe('resumo do tráfego (conferido com a tela de referência, 19/10/2026)', () => {
  // 63 un. de gelatina (9,90) + 2.835 un. dos demais (6,10) = 2.898 un. em 568 itens => R$ 17.917,20
  const kits = [{ kit: '63 Gelatina Max', pedidos: 1 }, { kit: '5 Produto Qualquer', pedidos: 567 }];
  const r = montarResumo({ faturamentoCentavos: 19_464_209, pedidos: 504, fretes: 504, kits, investimentoCentavos: 10_521_141 }, PARAMETROS_PADRAO);
  const valor = (c: string) => r.linhas.find((l) => l.codigo === c)?.valorCentavos;

  it('linhas', () => {
    expect(valor('taxa-cartao')).toBe(1_946_421);
    expect(valor('pis')).toBe(126_517);
    expect(valor('cofins')).toBe(583_926);
    expect(valor('irpj')).toBe(416_534);
    expect(valor('csll')).toBe(229_678);
    expect(valor('frete')).toBe(902_160);
    expect(valor('custo-produto')).toBe(1_791_720);
    expect(r.unidades).toBe(2898);
  });
  it('totais, ROAS, sobra e margem', () => {
    expect(r.totalCustosCentavos).toBe(16_518_097);
    expect(r.sobraCentavos).toBe(2_946_112);
    expect(r.margemBp).toBe(1514);
    expect(r.roasCentesimos).toBe(185);
    expect(r.ticketMedioCentavos).toBe(38_619);
    expect(r.linhas[0]?.porPedidoCentavos).toBe(20_875);
  });
  it('frete é por remessa: pedidos juntos pagam um frete só', () => {
    const juntos = montarResumo({ faturamentoCentavos: 100_000, pedidos: 10, fretes: 7, kits: [], investimentoCentavos: 0 }, PARAMETROS_PADRAO);
    expect(juntos.linhas.find((l) => l.codigo === 'frete')?.valorCentavos).toBe(7 * 1790);
  });
  it('sem investimento: não inventa ROAS, sobra nem margem', () => {
    const s = montarResumo({ faturamentoCentavos: 19_464_209, pedidos: 504, fretes: 504, kits, investimentoCentavos: null }, PARAMETROS_PADRAO);
    expect(s.roasCentesimos).toBeNull();
    expect(s.sobraCentavos).toBeNull();
    expect(s.margemBp).toBeNull();
    expect(s.totalCustosCentavos).toBeNull();
    expect(s.linhas[0]?.valorCentavos).toBeNull();
    expect(s.totalCustosSemInvestimentoCentavos).toBe(16_518_097 - 10_521_141);
  });
  it('período vazio: sem divisão por zero', () => {
    const v = montarResumo({ faturamentoCentavos: 0, pedidos: 0, fretes: 0, kits: [], investimentoCentavos: 0 }, PARAMETROS_PADRAO);
    expect(v.ticketMedioCentavos).toBeNull();
    expect(v.margemBp).toBeNull();
    expect(v.roasCentesimos).toBeNull();
  });
});

const MC = -40_803; // 1.005,10 × 0,70 − 1.010,55 × 1,10 = −408,035 (meio centavo: arredonda para cima), arredondado uma vez

describe('RedTrack: investimento', () => {
  beforeEach(() => {
    envMock.REDTRACK_API_KEY = 'chave-de-teste';
    limparCacheRedtrack();
  });
  const linhas = [
    { offer: 'Pagah - Front', cost: '1000.55', convtype2: 3, revenuetype2: '900.10', revenuetype3: 100, revenuetype4: 55 },
    { offer: 'Buygoods US', cost: 999, convtype2: 50, revenuetype2: 7000 },
    { offer: 'PAGAH upsell', cost: 10, convtype2: 1, revenuetype9: '20.05', revenuetype6: 5 },
  ];

  it('soma só as ofertas Pagah, em centavos', () => {
    expect(somarCusto(linhas, 'pagah')).toBe(100_055 + 1000);
  });

  it('faturamento = revenuetype 2+3; downsells (6 a 9) à parte; o 4 fica de fora; compras = convtype2', () => {
    expect(somarRedtrack(linhas, 'pagah')).toEqual({ custoCentavos: 101_055, faturamentoCentavos: 100_010, downsellsCentavos: 2_505, frontRevenueCentavos: 102_515, baseMcBrCentavos: 100_510, mcBrCentavos: MC, compras: 4 });
  });

  it('arredonda só no total: somar linhas já arredondadas deixava centavos a menos que o RedTrack', () => {
    // três linhas de R$ 0,004 de custo e R$ 10,004 de receita: por linha seria 3 × 0,00 = 0,00 e 3 × 10,00 = 30,00; exato é 0,012 e 30,012
    const l = [1, 2, 3].map(() => ({ offer: 'pagah', cost: 0.004, revenuetype2: 10.004 }));
    const r = somarRedtrack(l, 'pagah');
    expect(r.custoCentavos).toBe(1); // 0,012 → 0,01
    expect(r.faturamentoCentavos).toBe(3001); // 30,012 → 30,01
    expect(r.frontRevenueCentavos).toBe(3001);
    // MC BR sobre o exato: 30,012 × 0,70 − 0,012 × 1,10 = 20,9952 → R$ 21,00
    expect(r.mcBrCentavos).toBe(2100);
  });

  it('sem chave: indisponível, sem chamar a rede', async () => {
    envMock.REDTRACK_API_KEY = undefined;
    const f = vi.fn();
    const r = await investimentoNoPeriodo('2026-10-19', '2026-10-19', f as unknown as Fetcher);
    expect(r).toMatchObject({ fonte: 'NAO_CONFIGURADO', centavos: null });
    expect(f).not.toHaveBeenCalled();
  });

  it('consulta com fuso de SP, usa cache e nunca devolve a chave', async () => {
    const f = vi.fn(async (_u: string) => ({ ok: true, status: 200, json: async () => linhas }));
    const a = await investimentoNoPeriodo('2026-10-19', '2026-10-19', f as unknown as Fetcher);
    const b = await investimentoNoPeriodo('2026-10-19', '2026-10-19', f as unknown as Fetcher);
    expect(a).toEqual({ fonte: 'REDTRACK', centavos: 101_055, faturamentoCentavos: 100_010, downsellsCentavos: 2_505, frontRevenueCentavos: 102_515, baseMcBrCentavos: 100_510, mcBrCentavos: MC, compras: 4 });
    expect(b).toEqual(a);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]?.[0]).toContain('timezone=America%2FSao_Paulo');
    expect(JSON.stringify(a)).not.toContain('chave-de-teste');
  });

  it('erro HTTP, rede e formato inesperado viram "indisponível" com motivo (sem expor a chave)', async () => {
    const http = await investimentoNoPeriodo('2026-10-01', '2026-10-01', (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as Fetcher);
    expect(http).toMatchObject({ fonte: 'ERRO', centavos: null });
    const rede = await investimentoNoPeriodo('2026-10-02', '2026-10-02', (async () => { throw new Error('boom chave-de-teste'); }) as unknown as Fetcher);
    expect(rede).toMatchObject({ fonte: 'ERRO', centavos: null });
    expect(JSON.stringify(rede)).not.toContain('chave-de-teste');
    const fmt = await investimentoNoPeriodo('2026-10-03', '2026-10-03', (async () => ({ ok: true, status: 200, json: async () => ({ x: 1 }) })) as unknown as Fetcher);
    expect(fmt).toMatchObject({ fonte: 'ERRO', centavos: null });
  });
});

describe('Call Center: receita → custos → sobra (conferido com a tela de referência, 19/10/2026)', () => {
  it('quantidade a partir de [CALLCENTER], potes e frascos', () => {
    expect(unidadesDoKit('[CALLCENTER] 3 Super Gel - $300')).toEqual({ unidades: 3, detectado: true });
    expect(unidadesDoKit('[Callcenter] Senior 100 - 3 Potes')).toEqual({ unidades: 3, detectado: true });
    expect(unidadesDoKit('[CALLCENTER] NeuroSilence 3 Frascos - R$ 300')).toEqual({ unidades: 3, detectado: true });
    expect(unidadesDoKit('[Callcenter] Turbogel - 3 un')).toEqual({ unidades: 3, detectado: true });
    expect(unidadesDoKit('[CALLCENTER] Gelatina Fit - 1 un - $100')).toEqual({ unidades: 1, detectado: true });
    expect(unidadesDoKit('Checkout |3 Nervepure - $267,30')).toEqual({ unidades: 3, detectado: true });
    expect(custoUnitarioDoKit('[CALLCENTER] 3 Super Gel - $300', PARAMETROS_PADRAO)).toBe(990);
    expect(custoUnitarioDoKit('[Callcenter] Turbogel - 3 un', PARAMETROS_PADRAO)).toBe(990);
  });

  // 196 un. de gel (9,90) + 495 un. dos demais (6,10) = 691 un. => R$ 4.959,90
  const kits = [{ kit: '196 Gel Teste', pedidos: 1 }, { kit: '495 Outro Produto', pedidos: 1 }];
  const r = montarResumoCallCenter({ faturamentoCentavos: 3_650_967, receitaLiquidaCentavos: 3_500_000, pedidos: 225, remessas: 225, kits, custosOperacaoCentavos: 0 }, PARAMETROS_PADRAO);
  const v = (c: string) => r.linhas.find((l) => l.codigo === c)?.valorCentavos;

  it('linhas e totais', () => {
    expect(v('taxa-cartao')).toBe(365_097);
    expect(v('frete')).toBe(402_750);
    expect(v('pis')).toBe(23_731);
    expect(v('cofins')).toBe(109_529);
    expect(v('irpj')).toBe(78_131);
    expect(v('csll')).toBe(43_081);
    expect(v('custo-produto')).toBe(495_990);
    expect(r.totalCustosCentavos).toBe(1_518_309);
    expect(r.sobraCentavos).toBe(2_132_658);
    expect(r.ticketMedioCentavos).toBe(16_227);
  });
  it('custos da operação entram na sobra; sem permissão a sobra não é calculada', () => {
    const c = montarResumoCallCenter({ faturamentoCentavos: 3_650_967, receitaLiquidaCentavos: 3_500_000, pedidos: 225, remessas: 225, kits, custosOperacaoCentavos: 500_000 }, PARAMETROS_PADRAO);
    expect(c.sobraCentavos).toBe(2_132_658 - 500_000);
    const s = montarResumoCallCenter({ faturamentoCentavos: 3_650_967, receitaLiquidaCentavos: 3_500_000, pedidos: 225, remessas: 225, kits, custosOperacaoCentavos: null }, PARAMETROS_PADRAO);
    expect(s.sobraCentavos).toBeNull();
    expect(s.margemBp).toBeNull();
  });
});

describe('MC BR (coluna do RedTrack)', () => {
  it('(Front + Upsell 1 + Downsell 1 + Downsell 2) × 70% − investimento × 110%, em centavos inteiros', () => {
    // 01–19/10: base 2.013.441,13 e investimento 1.211.897,38 (valores medidos)
    expect(mcBrCentavos(201_344_113, 121_189_738)).toBe(140_940_879 - 133_308_712);
    expect(mcBrCentavos(0, 10_000)).toBe(-11_000);
  });
});
