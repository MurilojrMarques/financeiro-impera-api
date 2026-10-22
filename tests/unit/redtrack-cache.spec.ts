import { beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ REDTRACK_API_KEY: 'k' as string | undefined, REDTRACK_BASE_URL: 'https://rt.example', REDTRACK_OFFER_FILTER: 'pagah', REDTRACK_TIMEOUT_MS: 1000, NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
vi.mock('../../src/config/env', () => ({ env: envMock }));

import { investimentoNoPeriodo, limparCacheRedtrack, type Fetcher } from '../../src/integrations/redtrack/redtrack.client';

const resposta = (cost: number) => async () => ({ ok: true, status: 200, json: async () => [{ offer: 'Pagah', cost, convtype2: 1, revenuetype2: 10 }] });
const esperar = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const agora = () => Date.now();

describe('cache do RedTrack (stale-while-revalidate, single-flight)', () => {
  beforeEach(() => {
    limparCacheRedtrack();
    vi.useRealTimers();
  });

  it('chamadas simultâneas do mesmo período viram UMA consulta ao RedTrack', async () => {
    const f = vi.fn(resposta(5));
    const rs = await Promise.all([1, 2, 3, 4].map(() => investimentoNoPeriodo('2026-10-01', '2026-10-19', f as unknown as Fetcher)));
    expect(f).toHaveBeenCalledTimes(1);
    expect(new Set(rs.map((r) => r.centavos)).size).toBe(1);
  });

  it('período fechado fica em cache por horas; aberto (inclui hoje) vence em 10 min, mas o valor velho é devolvido NA HORA e renovado por trás', async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    let custo = 1;
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ offer: 'Pagah', cost: custo }] }));
    const r1 = await investimentoNoPeriodo(hoje, hoje, f as unknown as Fetcher);
    expect(r1.centavos).toBe(100);

    // 11 min depois: vencido (período aberto). A tela recebe o valor antigo imediatamente e o cache é atualizado em segundo plano.
    const spy = vi.spyOn(Date, 'now');
    const base = agora();
    spy.mockReturnValue(base + 11 * 60_000);
    custo = 2;
    const r2 = await investimentoNoPeriodo(hoje, hoje, f as unknown as Fetcher);
    expect(r2.centavos).toBe(100); // não esperou o RedTrack
    await esperar();
    expect(f).toHaveBeenCalledTimes(2);
    const r3 = await investimentoNoPeriodo(hoje, hoje, f as unknown as Fetcher);
    expect(r3.centavos).toBe(200); // já renovado
    spy.mockRestore();
  });

  it('período já fechado não é consultado de novo em 1 hora', async () => {
    const f = vi.fn(resposta(7));
    await investimentoNoPeriodo('2026-01-01', '2026-01-31', f as unknown as Fetcher);
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValue(agora() + 60 * 60_000);
    await investimentoNoPeriodo('2026-01-01', '2026-01-31', f as unknown as Fetcher);
    expect(f).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('falha ao renovar mantém o último valor bom e erro nunca é guardado como se fosse dado', async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const ok = vi.fn(resposta(3));
    await investimentoNoPeriodo(hoje, hoje, ok as unknown as Fetcher);
    const ruim = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValue(agora() + 11 * 60_000);
    const r = await investimentoNoPeriodo(hoje, hoje, ruim as unknown as Fetcher);
    await esperar();
    expect(r.centavos).toBe(300);
    expect((await investimentoNoPeriodo(hoje, hoje, ruim as unknown as Fetcher)).centavos).toBe(300); // continua valendo o último bom
    spy.mockRestore();

    limparCacheRedtrack();
    const so_erro = await investimentoNoPeriodo(hoje, hoje, ruim as unknown as Fetcher);
    expect(so_erro).toMatchObject({ fonte: 'ERRO', centavos: null });
    expect(ruim).toHaveBeenCalledTimes(3);
    await investimentoNoPeriodo(hoje, hoje, ruim as unknown as Fetcher); // erro não ficou em cache: consulta de novo
    expect(ruim).toHaveBeenCalledTimes(4);
  });
});
