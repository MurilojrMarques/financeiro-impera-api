import { describe, expect, it } from 'vitest';
import { classificar, derivarTipoVenda, type ClassificacaoInput, type RegraClassificacaoInput } from '../../src/modules/classificacoes/classificacao.service';

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
