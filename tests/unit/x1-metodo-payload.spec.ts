import { describe, expect, it } from 'vitest';
import { extrairVendedorDoPayload, normalizarMetodo } from '../../src/integrations/google-sheets/google-sheets.schemas';
import { ATRIBUTOS_VAZIOS, type Atributos } from '../../src/modules/vendas/domain/venda.aggregator';
import { ehX1, isCriterioX1, type CriterioX1 } from '../../src/modules/vendas/domain/x1';

// regra decidida (doc Pagah 16/10): Pix sem valor líquido do vendedor 889739
const CRITERIO: CriterioX1 = {
  todas: [
    { campo: 'METODO', operador: 'IGUAL', valor: 'pix' },
    { campo: 'VENDEDOR_ID', operador: 'IGUAL', valor: '889739' },
    { campo: 'LIQUIDO', operador: 'IGUAL', valor: 'VAZIO' },
  ],
};
const venda = (o: Partial<Atributos>): Atributos => ({ ...ATRIBUTOS_VAZIOS, metodo: 'Pix', vendedorId: '889739', valorLiquidoCentavos: null, ...o });

describe('X1: Pix sem valor líquido do vendedor 889739', () => {
  it('só é X1 quando TODAS as condições valem', () => {
    expect(ehX1(venda({}), CRITERIO)).toBe(true);
    expect(ehX1(venda({ valorLiquidoCentavos: 0 }), CRITERIO)).toBe(true); // líquido 0 = vazio
    expect(ehX1(venda({ valorLiquidoCentavos: 4500 }), CRITERIO)).toBe(false); // Pix COM líquido: comissão normal
    expect(ehX1(venda({ metodo: 'Cartão' }), CRITERIO)).toBe(false);
    expect(ehX1(venda({ vendedorId: '123' }), CRITERIO)).toBe(false);
    expect(ehX1(venda({ vendedorId: null }), CRITERIO)).toBe(false);
  });

  it('sem critério configurado, nenhuma venda é X1 (nunca presumido)', () => {
    expect(ehX1(venda({}), null)).toBe(false);
  });

  it('valida a configuração (rejeita lixo) e aceita condição única', () => {
    expect(isCriterioX1(CRITERIO)).toBe(true);
    expect(isCriterioX1({ campo: 'LOJA', operador: 'IGUAL', valor: 'X1' })).toBe(true);
    expect(isCriterioX1({ todas: [] })).toBe(false);
    expect(isCriterioX1({ todas: [{ campo: 'SENHA', operador: 'IGUAL', valor: 'x' }] })).toBe(false);
    expect(isCriterioX1('x1')).toBe(false);
  });
});

describe('método de pagamento padronizado', () => {
  it.each([['Cartão', 'Cartão'], ['cartao', 'Cartão'], ['CARTÃO DE CRÉDITO', 'Cartão'], ['pix', 'Pix'], ['Pix', 'Pix'], ['boleto', 'Boleto'], ['Boleto', 'Boleto'], ['  ', null], [null, null]])(
    '%s -> %s',
    (entrada, saida) => expect(normalizarMetodo(entrada as string | null)).toBe(saida),
  );
  it('valor desconhecido é preservado (não inventa categoria)', () => {
    expect(normalizarMetodo('Carteira Digital')).toBe('Carteira Digital');
  });
});

describe('payload: extrai só o id do vendedor e descarta todo o resto (dados pessoais)', () => {
  const PAYLOAD = JSON.stringify({
    id_user_venda: 889739, cliente_cpf: '000.000.000-00', cliente_email: 'x@y.z', cliente_nome: 'Fulano', cliente_telefone: '1', cliente_endereco: 'Rua',
    url_origem: '/checkout/v2/pedido/TOKEN-SECRETO', pix_copia_cola: 'PIXSECRETO',
  });

  it('devolve apenas { vendedorId }', () => {
    const r = extrairVendedorDoPayload(PAYLOAD);
    expect(r).toEqual({ vendedorId: '889739' });
    expect(JSON.stringify(r)).not.toMatch(/000\.000|x@y|Fulano|TOKEN|PIXSECRETO|Rua/);
  });

  it('JSON inválido, vazio ou id zero/malformado => null (sem erro)', () => {
    expect(extrairVendedorDoPayload('não é json')).toEqual({ vendedorId: null });
    expect(extrairVendedorDoPayload('')).toEqual({ vendedorId: null });
    expect(extrairVendedorDoPayload(null)).toEqual({ vendedorId: null });
    expect(extrairVendedorDoPayload('{"id_user_venda": 0}')).toEqual({ vendedorId: null });
    expect(extrairVendedorDoPayload('{"id_user_venda": "<script>"}')).toEqual({ vendedorId: null });
    expect(extrairVendedorDoPayload('{"outro": 1}')).toEqual({ vendedorId: null });
  });
});
