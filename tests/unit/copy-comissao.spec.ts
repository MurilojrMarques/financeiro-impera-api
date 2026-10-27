import { describe, expect, it } from 'vitest';
import { comissaoCopyNoPeriodo, cortaMesFechado } from '../../src/integrations/copy-supabase/copy-comissao';

describe('comissão do Front (sistema de copy)', () => {
  const FECHADOS = ['2026-08-01', '2026-09-01'];

  it('período que corta um mês fechado não é apurável; mês inteiro ou período em mês aberto são', () => {
    expect(cortaMesFechado('2026-09-10', '2026-09-20', FECHADOS)).toBe('2026-09');
    expect(cortaMesFechado('2026-08-20', '2026-09-05', FECHADOS)).toBe('2026-08');
    expect(cortaMesFechado('2026-09-15', '2026-10-05', FECHADOS)).toBe('2026-09');
    expect(cortaMesFechado('2026-09-01', '2026-09-30', FECHADOS)).toBeNull();
    expect(cortaMesFechado('2026-08-01', '2026-10-25', FECHADOS)).toBeNull();
    expect(cortaMesFechado('2026-10-05', '2026-10-12', FECHADOS)).toBeNull();
  });

  it('sem o banco do copy configurado fica indisponível (nunca zero); antes de 01/08/2026 vale outra regra', async () => {
    expect(await comissaoCopyNoPeriodo('2026-10-01', '2026-10-25')).toMatchObject({ disponivel: false, motivo: 'NAO_CONFIGURADO' });
  });
});
