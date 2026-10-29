import { describe, expect, it } from 'vitest';
import { chaveVsl, gestorDaCampanha, linhasPorVsl, type LinhaRedtrackLanding } from '../../src/modules/comissoes/vsl.domain';

describe('chaveVsl: a VSL que está atrás do nome da landing', () => {
  it('nicho + oferta + produto; lead, MLD e OTMZ da mesma oferta caem na mesma VSL', () => {
    expect(chaveVsl('[FB][NE][BR][OF04][VT][LD12] - Nerve Pure - https://escolhanatural.site/np/of04/lead12/ | 26/09/26').vsl).toBe('NE OF04 NERVE PURE');
    expect(chaveVsl('[TB][NE][BR][OF04][LD02] - MLD03 - Nerve Pure - https://escolhanatural.site/np/of04/lead02/m03/ | 22/07/26 COPY').vsl).toBe('NE OF04 NERVE PURE');
  });

  it('vslNN da URL separa as VSLs do mesmo produto; mini-VSL é peça própria', () => {
    expect(chaveVsl('[FB][DA][BR][OF03][VT] - Articure - https://x.site/da/ar/of3/vsl03/lead01/').vsl).toBe('DA OF03 ARTICURE VSL03');
    expect(chaveVsl('[FB][DA][BR][OF03][VT] - Articure Gotas - https://x.site/da/ar/of3/mini/lead01/').vsl).toBe('DA OF03 ARTICURE GOTAS MINI-VSL');
  });

  it('o mesmo produto escrito de jeitos diferentes vira um só', () => {
    expect(chaveVsl('[FB][MM][BR][OF04] - Memokare - https://x.site/mm/mk/of04/vsl01/lead02/').vsl).toBe('MM OF04 MEMO KARE VSL01');
  });

  it('oferta do nome diferente da da URL: vale a URL (a página que está no ar); OF05 x OFC05 é a mesma', () => {
    expect(chaveVsl('[FB][DB][BR][OF03] - Glico Drops - https://x.site/db/gdr/ofc09/lead03/').oferta).toBe('OFC09');
    expect(chaveVsl('[FB][MM][BR][OFC05] - Neuro Silence - https://x.site/mm/ns/of5/vsl01/').oferta).toBe('OFC05');
  });

  it('sem URL no nome, a chave sai incompleta em vez de inventar', () => {
    expect(chaveVsl('[FB][ED][BR][OFC32]').vsl).toBe('ED OFC32 ?');
  });
});

describe('gestorDaCampanha', () => {
  it('o nome no fim da campanha; [WAN] é sempre o Wanderson; sem nome fica "?"', () => {
    expect(gestorDaCampanha('[FB] - BR - VSL 04 - NEUROPATIA | 01/09 - P. NERY - G. JOAO')).toBe('JOÃO');
    expect(gestorDaCampanha('[FB] - BR - VSL 05 - NEUROPATIA | 24/09 - P. FERNANDA - G. DOUG')).toBe('DOUGLAS');
    expect(gestorDaCampanha('[FB] - BR - VSL 03 - MEMORIA | 18/09 - P. SABRINA | G. GREG')).toBe('GREG');
    expect(gestorDaCampanha('[WAN] - [TB] - BR - VSL 03 - NEUROPATIA')).toBe('WANDERSON');
    expect(gestorDaCampanha('[FB] - BR - sem gestor')).toBe('?');
  });
});

describe('linhasPorVsl', () => {
  const linha = (o: Partial<LinhaRedtrackLanding>): LinhaRedtrackLanding => ({ network: 'Pagah', campaignId: 'c1', campaign: '[FB] - BR - VSL 04 - NEUROPATIA | 01/09 - G. LUCAS', landing: '[FB][NE][BR][OF04][VT] - Nerve Pure - https://x.site/np/of04/lead1/', cost: 1000, rev: 3000, ...o });

  it('MC BR = receita-base × 0,70 − investimento × 1,10; só a rede pedida; linha zerada não conta', () => {
    const r = linhasPorVsl([linha({}), linha({ network: 'BuyGoods' }), linha({ cost: 0, rev: 0 })], 'pagah');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ vsl: 'NE OF04 NERVE PURE', gestor: 'LUCAS' });
    expect(r[0]!.mc).toBeCloseTo(3000 * 0.7 - 1000 * 1.1, 6);
  });

  it('presell sem landing: o nicho da campanha decide ("<NICHO> SEM LANDING")', () => {
    const r = linhasPorVsl([linha({ landing: '', campaign: '[WAN] - [TB] - BR - VSL 03 - NEUROPATIA' })], 'Pagah');
    expect(r[0]).toMatchObject({ vsl: 'NE SEM LANDING', gestor: 'WANDERSON' });
  });

  it('VSL cadastrada como "mesma" de outra soma na outra', () => {
    const r = linhasPorVsl([linha({})], 'Pagah', { 'NE OF04 NERVE PURE': 'NE OF04 NEUROPURE' });
    expect(r[0]!.vsl).toBe('NE OF04 NEUROPURE');
  });
});
