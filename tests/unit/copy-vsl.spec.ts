import { describe, expect, it } from 'vitest';
import { montarVslDoCopy } from '../../src/integrations/copy-supabase/copy-vsl';

describe('VSLs do banco do copy → entrada do motor de comissão', () => {
  const linhas = [
    { vsl: 'NE OF04 NERVE PURE', gestor: 'LUCAS', copywriter_nome: 'YAN', editor: 'MINEIRO', mc: '1234.56' },
    { vsl: 'NE OF04 NERVE PURE', gestor: 'JOÃO', copywriter_nome: 'YAN', editor: 'MINEIRO', mc: '-10.5' },
    { vsl: 'DA OF03 ARTICURE', gestor: 'GREG', copywriter_nome: null, editor: null, mc: '70' },
    { vsl: 'NE SEM LANDING', gestor: 'WANDERSON', copywriter_nome: 'Empresa', editor: 'SEM VSL', mc: '0.0049' },
  ];

  it('cada linha da view vira uma linha de MC BR com o gestor, e o MC chega como número', () => {
    const r = montarVslDoCopy(linhas);
    expect(r.linhas).toHaveLength(4);
    expect(r.linhas[0]).toEqual({ vsl: 'NE OF04 NERVE PURE', gestor: 'LUCAS', mc: 1234.56, cost: 0, rev: 0 });
    expect(r.linhas[1]).toMatchObject({ gestor: 'JOÃO', mc: -10.5 });
  });

  it('o cadastro é um por VSL, com o dono em maiúsculas e sem dono quando a view não traz', () => {
    const r = montarVslDoCopy(linhas);
    expect(r.cadastro).toEqual([
      { chave: 'NE OF04 NERVE PURE', dono: 'YAN', editor: 'MINEIRO', mesmaVsl: null },
      { chave: 'DA OF03 ARTICURE', dono: null, editor: null, mesmaVsl: null },
      { chave: 'NE SEM LANDING', dono: 'EMPRESA', editor: 'SEM VSL', mesmaVsl: null },
    ]);
  });

  it('vazio vira vazio', () => {
    expect(montarVslDoCopy([])).toEqual({ linhas: [], cadastro: [] });
  });
});
