import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase } from '../../src/config/database';
import { app, resetDb, tokenDe } from '../helpers/db';

vi.mock('../../src/integrations/copy-supabase/copy-comissao', () => ({
  comissaoCopyNoPeriodo: vi.fn(async (de: string) =>
    de === '2026-07-01'
      ? { disponivel: false, motivo: 'REGRA_ANTERIOR', mensagem: 'A comissão de 5% do copy vale a partir de 01/08/2026.' }
      : {
          disponivel: true,
          estado: 'PROVISORIO',
          comissaoCentavos: 90_000,
          aPagarCentavos: 100_000,
          mcBrComissionavelCentavos: 1_800_000,
          mcBrSemComissaoCentavos: 50_000,
          pessoas: [
            { copywriterId: 'a', nome: 'A', mcBrCentavos: 2_000_000, comissaoCentavos: 100_000, aPagarCentavos: 100_000 },
            { copywriterId: 'b', nome: 'B', mcBrCentavos: -200_000, comissaoCentavos: -10_000, aPagarCentavos: 0 },
          ],
        },
  ),
}));

const Q = 'de=2026-10-01&ate=2026-10-25';
const get = (url: string, token: string) => request(app).get(`/api/v1${url}`).set('Authorization', token);

describe('GET /comissoes/resumo', () => {
  beforeEach(resetDb);
  afterAll(closeDatabase);

  it('exige login e perfil de análise para cima', async () => {
    expect((await request(app).get(`/api/v1/comissoes/resumo?${Q}`)).status).toBe(401);
    expect((await get(`/comissoes/resumo?${Q}`, await tokenDe('LEITURA'))).status).toBe(403);
  });

  it('ANALISTA vê os totais, mas não a lista por pessoa; FINANCEIRO vê a lista; o MC BR não é comissão', async () => {
    const analista = (await get(`/comissoes/resumo?${Q}`, await tokenDe('ANALISTA'))).body.data;
    expect(analista.front).toMatchObject({ disponivel: true, estado: 'PROVISORIO', comissaoCentavos: 90_000, aPagarCentavos: 100_000, pessoas: null, quantidadePessoas: 2 });
    expect(analista.backendOutros.emImplementacao).toBe(true);
    expect(analista.totalCentavos).toBe(90_000 + analista.callCenter.comissaoCentavos + analista.recuperacao.comissaoCentavos + analista.afiliados.comissaoCentavos);
    expect(analista.totalSemFront).toBe(false);

    const fin = (await get(`/comissoes/resumo?${Q}`, await tokenDe('FINANCEIRO'))).body.data;
    expect(fin.front.pessoas.map((p: { nome: string }) => p.nome)).toEqual(['A', 'B']);
  });

  it('período não apurável no copy: o Front fica indisponível (com o motivo) e fora do total', async () => {
    const d = (await get('/comissoes/resumo?de=2026-07-01&ate=2026-07-31', await tokenDe('FINANCEIRO'))).body.data;
    expect(d.front).toMatchObject({ disponivel: false, motivo: 'REGRA_ANTERIOR' });
    expect(d.totalSemFront).toBe(true);
    expect(d.totalCentavos).toBe(d.callCenter.comissaoCentavos + d.recuperacao.comissaoCentavos + d.afiliados.comissaoCentavos);
  });
});
