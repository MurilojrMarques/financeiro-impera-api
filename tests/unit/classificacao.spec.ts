import { describe, expect, it } from 'vitest';
import { classificar, derivarTipoVenda, origemEhCallCenter, type ClassificacaoInput, type RegraClassificacaoInput } from '../../src/modules/classificacoes/classificacao.service';

const base: ClassificacaoInput = {
  afiliadoNome: null, tipoBruto: 'front', kitNome: 'Kit 3 potes', origem: null, tipoAtendimento: null,
  loja: 'Loja A', campanha: null, utmSource: null, src: null, checkout: null,
};
const regraSms: RegraClassificacaoInput = {
  id: 'r1', campo: 'ORIGEM', operador: 'IGUAL', valor: 'SMS', grupo: 'BACKEND_OUTROS', prioridade: 10, versao: 1,
};

describe('classificação de receitas (grupos mutuamente exclusivos)', () => {
  it('Front: compra inicial, upsell e downsell', () => {
    expect(classificar(base, []).grupo).toBe('FRONT');
    expect(classificar({ ...base, tipoBruto: 'upsell' }, [])).toMatchObject({ grupo: 'FRONT', tipoVenda: 'UPSELL' });
    expect(classificar({ ...base, tipoBruto: 'downsell' }, [])).toMatchObject({ grupo: 'FRONT', tipoVenda: 'DOWNSELL' });
  });

  it('downsell também é identificado pelo nome do kit iniciado por "(Downsell)"', () => {
    expect(derivarTipoVenda('front', '(Downsell) Kit 1 pote')).toBe('DOWNSELL');
    expect(derivarTipoVenda('front', 'Kit (Downsell)')).toBe('FRONT'); // só prefixo conta
  });

  it('Call Center: tipo = "call center" (ignora caixa/acento/espaços)', () => {
    expect(classificar({ ...base, tipoBruto: '  Call   Center ' }, []).grupo).toBe('CALL_CENTER');
  });

  it('Afiliado tem prioridade sobre Call Center e sobre regras de back-end', () => {
    const r = classificar({ ...base, afiliadoNome: 'André Pinheiro', tipoBruto: 'call center', origem: 'SMS' }, [regraSms]);
    expect(r.grupo).toBe('AFILIADO');
  });

  it('Back-end Outros só nasce de regra explícita e auditável (guarda id/versão)', () => {
    const r = classificar({ ...base, origem: 'sms' }, [regraSms]);
    expect(r).toMatchObject({ grupo: 'BACKEND_OUTROS', regraId: 'r1' });
    expect(r.motivo).toContain('r1');
  });

  it('sem regra, origem SMS não vira Back-end por "adivinhação"', () => {
    expect(classificar({ ...base, origem: 'SMS' }, []).grupo).toBe('FRONT'); // tipo front manda
    expect(classificar({ ...base, tipoBruto: null, origem: 'SMS' }, []).grupo).toBe('NAO_CLASSIFICADA');
  });

  it('nome de produto/campanha nunca classifica sozinho', () => {
    const r = classificar({ ...base, tipoBruto: null, kitNome: 'Recuperação de vendas SMS', campanha: 'email-pos-venda' }, []);
    expect(r.grupo).toBe('NAO_CLASSIFICADA');
  });

  it('regras respeitam prioridade (menor número vence)', () => {
    const outra: RegraClassificacaoInput = { ...regraSms, id: 'r2', prioridade: 5, grupo: 'NAO_CLASSIFICADA' };
    expect(classificar({ ...base, origem: 'SMS' }, [regraSms, outra]).regraId).toBe('r2');
  });

  it('afiliados com nomes só parecidos continuam afiliados distintos (classificação não mescla)', () => {
    expect(classificar({ ...base, afiliadoNome: 'André Pinheiro' }, []).grupo).toBe('AFILIADO');
    expect(classificar({ ...base, afiliadoNome: 'Andre Pinheiro Jr' }, []).grupo).toBe('AFILIADO');
  });
});

describe('canal da planilha (coluna `canal` do EVENTOS) decide o grupo', () => {
  const base = { afiliadoNome: null, tipoBruto: 'front', kitNome: 'Kit', origem: null, tipoAtendimento: null, loja: null, campanha: null, utmSource: null, src: null, checkout: null };
  it.each([
    ['front', 'FRONT'],
    ['call center', 'CALL_CENTER'],
    ['recuperação de vendas', 'RECUPERACAO'],
    ['Recuperacao de Vendas', 'RECUPERACAO'],
    ['back end', 'BACKEND_OUTROS'],
    ['afiliado', 'AFILIADO'],
  ])('canal %s => %s', (canal, grupo) => {
    expect(classificar({ ...base, canalPlanilha: canal }, []).grupo).toBe(grupo);
  });

  it('a venda fica com quem fechou: o canal vence tipo, afiliado e regras de utm_source', () => {
    const regra = { id: 'r1', campo: 'UTM_SOURCE' as const, operador: 'IGUAL' as const, valor: 'SMSFunnel', grupo: 'BACKEND_OUTROS' as const, prioridade: 10, versao: 1 };
    expect(classificar({ ...base, tipoBruto: 'call center', canalPlanilha: 'recuperação de vendas' }, []).grupo).toBe('RECUPERACAO');
    expect(classificar({ ...base, utmSource: 'SMSFunnel', canalPlanilha: 'front' }, [regra]).grupo).toBe('FRONT');
    expect(classificar({ ...base, afiliadoNome: 'André', canalPlanilha: 'front' }, []).grupo).toBe('FRONT');
  });

  it('sem canal (ou canal desconhecido) mantém a precedência anterior', () => {
    const regra = { id: 'r1', campo: 'UTM_SOURCE' as const, operador: 'IGUAL' as const, valor: 'SMSFunnel', grupo: 'BACKEND_OUTROS' as const, prioridade: 10, versao: 1 };
    expect(classificar({ ...base, utmSource: 'SMSFunnel' }, [regra]).grupo).toBe('BACKEND_OUTROS');
    expect(classificar({ ...base, utmSource: 'SMSFunnel', canalPlanilha: 'canal novo' }, [regra]).grupo).toBe('BACKEND_OUTROS');
    expect(classificar({ ...base, tipoBruto: 'call center' }, []).grupo).toBe('CALL_CENTER');
  });
});

describe('origem do Pagah (fechamento do dono, a partir de 01/10/2026)', () => {
  const out = new Date('2026-10-15T12:00:00-03:00');
  const set = new Date('2026-09-15T12:00:00-03:00');
  const com = (o: Partial<ClassificacaoInput>) => classificar({ ...base, tipoBruto: 'call center', pagoEm: out, ...o }, []);

  it('origem "Call" ou "Whats" é Call Center, mesmo que o canal da planilha diga afiliado ou recuperação (os 16 de outubro)', () => {
    expect(com({ origem: 'Call', canalPlanilha: 'afiliado' }).grupo).toBe('CALL_CENTER');
    expect(com({ origem: 'Call', canalPlanilha: 'recuperação de vendas' }).grupo).toBe('CALL_CENTER');
    expect(com({ origem: 'Whats', canalPlanilha: 'front' }).grupo).toBe('CALL_CENTER');
  });

  it('vendedor com nome na origem NÃO é Call Center: Jessica Teste, Leonardo Bittencourt, Conversão… vão para Recuperação', () => {
    for (const origem of ['Jessica Teste', 'Leonardo Bittencourt', 'Conversão', 'Lucas Fernandes', 'Luis Ramos']) {
      expect(com({ origem, canalPlanilha: 'call center' })).toMatchObject({ grupo: 'RECUPERACAO', motivo: `origem do Pagah = ${origem}` });
    }
  });

  it('"Site" que a planilha chamava de Call Center é Front', () => {
    expect(com({ origem: 'Site', canalPlanilha: 'call center' }).grupo).toBe('FRONT');
  });

  it('é a fórmula do dono, caixa inclusa: "Jeferson CALL (800K)" não casa com "Call"', () => {
    expect(origemEhCallCenter('Jeferson CALL (800K)')).toBe(false);
    expect(com({ origem: 'Jeferson CALL (800K)', canalPlanilha: 'call center' }).grupo).toBe('RECUPERACAO');
    expect(origemEhCallCenter('Call')).toBe(true);
    expect(origemEhCallCenter('Whats')).toBe(true);
    expect(origemEhCallCenter(null)).toBe(false);
  });

  it('a origem só mexe no Call Center: afiliado e recuperação que ela não contradiz ficam como estavam', () => {
    expect(com({ origem: 'Matheus Barbosa', canalPlanilha: 'afiliado' }).grupo).toBe('AFILIADO');
    expect(com({ origem: 'Pedro Carvalho', canalPlanilha: 'recuperação de vendas' }).grupo).toBe('RECUPERACAO');
    expect(com({ origem: 'Site', canalPlanilha: 'afiliado' }).grupo).toBe('AFILIADO');
    expect(classificar({ ...base, afiliadoNome: 'André', tipoBruto: 'call center', origem: 'Site', pagoEm: out }, []).grupo).toBe('AFILIADO');
  });

  it('regra cadastrada à mão que casa com a venda vence a origem do Pagah (WhatsApp de back-end não vira Call Center)', () => {
    const regraWhats: RegraClassificacaoInput = { id: 'w1', campo: 'ORIGEM', operador: 'IGUAL', valor: 'WhatsApp', grupo: 'BACKEND_OUTROS', prioridade: 5, versao: 1 };
    expect(classificar({ ...base, tipoBruto: 'front', origem: 'WhatsApp', pagoEm: out }, [regraWhats])).toMatchObject({ grupo: 'BACKEND_OUTROS', regraId: 'w1' });
    expect(classificar({ ...base, tipoBruto: 'front', origem: 'Whats', pagoEm: out }, [regraWhats]).grupo).toBe('CALL_CENTER'); // a regra não casa com "Whats"
  });

  it('antes de outubro nada muda: setembro, com nome de atendente "#id" na origem, segue Call Center', () => {
    expect(com({ origem: 'Vitor Wollenhaupt #410', canalPlanilha: 'call center', pagoEm: set }).grupo).toBe('CALL_CENTER');
    expect(com({ origem: 'Vitor Wollenhaupt #410', pagoEm: set }).grupo).toBe('CALL_CENTER');
    expect(com({ origem: 'Site', canalPlanilha: 'call center', pagoEm: set }).grupo).toBe('CALL_CENTER');
  });

  it('sem origem (o Pagah ainda não a entregou) vale o canal da planilha, como antes', () => {
    expect(com({ origem: null, canalPlanilha: 'call center' }).grupo).toBe('CALL_CENTER');
    expect(com({ origem: '  ', canalPlanilha: 'recuperação de vendas' }).grupo).toBe('RECUPERACAO');
    expect(com({ origem: 'Jessica Teste', canalPlanilha: 'call center', pagoEm: null }).grupo).toBe('CALL_CENTER');
  });
});
