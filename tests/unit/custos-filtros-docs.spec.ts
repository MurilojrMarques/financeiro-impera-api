import { describe, expect, it } from 'vitest';
import { custosDeRegras, ocorrenciasNoPeriodo, type LancamentoBase, type RegraCustoInput } from '../../src/modules/financeiro/custos.calc';
import { filtrosSchema, ordenacaoSegura, resolverFiltro, filtroAnterior } from '../../src/shared/validators/filtros';
import { buildOpenApi } from '../../src/docs/openapi';
import { ROUTES } from '../../src/docs/registry';

const utc = (s: string) => new Date(`${s}T00:00:00Z`);

describe('custos operacionais', () => {
  const base: LancamentoBase = {
    id: 'c1', descricao: 'Ferramenta', categoriaId: 'cat', categoria: 'Software', grupo: null, valorCentavos: 10000,
    vencimento: utc('2026-08-31'), statusPagamento: 'PENDENTE', recorrencia: null,
  };

  it('lançamento avulso entra só se o vencimento está no período', () => {
    expect(ocorrenciasNoPeriodo(base, utc('2026-08-01'), utc('2026-08-31'))).toHaveLength(1);
    expect(ocorrenciasNoPeriodo(base, utc('2026-09-01'), utc('2026-09-30'))).toHaveLength(0);
  });

  it('cancelado nunca conta', () => {
    expect(ocorrenciasNoPeriodo({ ...base, statusPagamento: 'CANCELADO' }, utc('2026-08-01'), utc('2026-08-31'))).toHaveLength(0);
  });

  it('recorrência mensal: projeta ocorrências, ajustando fim de mês, e marca como projetadas', () => {
    const rec = { ...base, recorrencia: { periodicidade: 'MENSAL' as const, inicio: utc('2026-08-31'), fim: null } };
    const o = ocorrenciasNoPeriodo(rec, utc('2026-08-01'), utc('2026-11-30'));
    expect(o.map((x) => x.data.toISOString().slice(0, 10))).toEqual(['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30']);
    expect(o.map((x) => x.projetada)).toEqual([false, true, true, true]);
  });

  it('recorrência respeita a data final', () => {
    const rec = { ...base, recorrencia: { periodicidade: 'SEMANAL' as const, inicio: utc('2026-08-31'), fim: utc('2026-09-14') } };
    expect(ocorrenciasNoPeriodo(rec, utc('2026-08-01'), utc('2026-12-31'))).toHaveLength(3);
  });

  const regra = (r: Partial<RegraCustoInput>): RegraCustoInput => ({
    id: 'r', nome: 'regra', tipo: 'PERCENTUAL_RECEITA', grupo: null, categoriaId: null, valorCentavos: null, percentualBps: null,
    vigenteDe: utc('2026-01-01'), vigenteAte: null, metodologia: 'teste', ...r,
  });
  const porGrupo = { FRONT: { receitaCentavos: 1_000_000, pedidos: 40 }, CALL_CENTER: { receitaCentavos: 500_000, pedidos: 10 } };

  it('percentual sobre a receita do grupo ou total; valor por pedido', () => {
    const { itens } = custosDeRegras(
      [regra({ id: 'a', percentualBps: 250, grupo: 'CALL_CENTER' }), regra({ id: 'b', percentualBps: 100 }), regra({ id: 'c', tipo: 'VALOR_POR_PEDIDO', valorCentavos: 500 })],
      utc('2026-10-01'), utc('2026-10-31'), porGrupo,
    );
    expect(itens.find((i) => i.regraId === 'a')?.valorCentavos).toBe(12500); // 2,5% de 5.000,00
    expect(itens.find((i) => i.regraId === 'b')?.valorCentavos).toBe(15000); // 1% de 15.000,00
    expect(itens.find((i) => i.regraId === 'c')?.valorCentavos).toBe(25000); // 50 pedidos × R$ 5,00
  });

  it('valor fixo mensal é rateado por dia no período parcial', () => {
    const { itens } = custosDeRegras([regra({ tipo: 'VALOR_FIXO_PERIODO', valorCentavos: 310000 })], utc('2026-10-01'), utc('2026-10-10'), porGrupo);
    expect(itens[0].valorCentavos).toBe(100000); // 10/31 de 3.100,00
  });

  it('regra por unidade é reportada como indisponível, nunca calculada com unidades presumidas', () => {
    const r = custosDeRegras([regra({ tipo: 'VALOR_POR_UNIDADE', valorCentavos: 800 })], utc('2026-10-01'), utc('2026-10-31'), porGrupo);
    expect(r.itens).toHaveLength(0);
    expect(r.indisponiveis[0].motivo).toMatch(/unidades/);
  });
});

describe('filtros padronizados', () => {
  it('período padrão = mês atual; comparativo = período anterior de mesma duração', () => {
    const f = resolverFiltro(filtrosSchema.parse({ de: '2026-10-10', ate: '2026-10-19' }));
    expect(f.modo).toBe('MOVIMENTACAO');
    expect(filtroAnterior(f)).toMatchObject({ de: '2026-09-30', ate: '2026-10-09' });
  });

  it('rejeita período invertido, longo demais e filtros inválidos', () => {
    expect(filtrosSchema.safeParse({ de: '2026-10-19', ate: '2026-10-01' }).success).toBe(false);
    expect(filtrosSchema.safeParse({ de: '2024-01-01', ate: '2026-10-01' }).success).toBe(false);
    expect(filtrosSchema.safeParse({ de: '2026-13-01' }).success).toBe(false);
    expect(filtrosSchema.safeParse({ grupo: 'OUTRO' }).success).toBe(false);
    expect(filtrosSchema.safeParse({ limit: '5000' }).success).toBe(false);
    expect(filtrosSchema.safeParse({ afiliadoId: 'não-uuid' }).success).toBe(false);
  });

  it('ordenação só aceita colunas da whitelist', () => {
    expect(ordenacaoSegura('valorVendaCentavos', ['pagoEm', 'valorVendaCentavos'] as const, 'pagoEm')).toBe('valorVendaCentavos');
    expect(ordenacaoSegura('id; DROP TABLE vendas', ['pagoEm'] as const, 'pagoEm')).toBe('pagoEm');
  });
});

describe('OpenAPI', () => {
  const spec = buildOpenApi() as { paths: Record<string, Record<string, { security?: unknown[] }>> };

  it('documenta todas as rotas do escopo, sem duplicatas', () => {
    const chaves = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(chaves).size).toBe(chaves.length);
    expect(ROUTES.length).toBeGreaterThanOrEqual(140);
    for (const p of ['/vendas/{pedido}/conciliacao', '/afiliados/{id}/regras-comissao', '/integracoes/sheets/sincronizar', '/classificacoes/simular', '/custos/{id}/anexos', '/health/ready']) {
      expect(spec.paths[p], p).toBeDefined();
    }
  });

  it('toda rota não pública exige Bearer; somente login/refresh/logout/health são públicos', () => {
    const publicas = ROUTES.filter((r) => !r.papeis).map((r) => r.path).sort();
    expect(publicas).toEqual(['/auth/login', '/auth/logout', '/auth/refresh', '/health/live', '/health/ready']);
    expect(spec.paths['/vendas'].get.security).toEqual([{ bearerAuth: [] }]);
  });
});
