import { describe, expect, it } from 'vitest';
import { montarBonusLead, VALOR_BONUS_LEAD_CENTAVOS } from '../../src/integrations/copy-supabase/copy-bonus-lead';

describe('bônus de lead e MLD confirmado no banco do copy → entrada do motor de comissão', () => {
  it('cada lead confirmada e paga vale R$ 500 para a autora, somadas por autora', () => {
    const r = montarBonusLead([
      { autor_nome: 'YAN', pagas: '1', decididas: '1' },
      { autor_nome: 'CAROL', pagas: '2', decididas: '3' },
    ]);
    expect(VALOR_BONUS_LEAD_CENTAVOS).toBe(50_000);
    expect(r.itens).toEqual([
      { copywriter: 'YAN', valorCentavos: 50_000 },
      { copywriter: 'CAROL', valorCentavos: 100_000 },
    ]);
    expect(r.decididas).toBe(4);
  });

  it('lead recusada, ou confirmada que não paga (autora = dona da VSL), conta como decisão mas não vira valor', () => {
    const r = montarBonusLead([
      { autor_nome: 'DOUGLAS', pagas: '0', decididas: '1' },
      { autor_nome: null, pagas: '0', decididas: '1' },
    ]);
    expect(r.itens).toEqual([]);
    expect(r.decididas).toBe(2);
  });

  it('vazio vira vazio', () => {
    expect(montarBonusLead([])).toEqual({ itens: [], decididas: 0 });
  });
});
