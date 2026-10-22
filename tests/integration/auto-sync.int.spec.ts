import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, prisma } from '../../src/config/database';
import { cicloAutomatico } from '../../src/jobs/auto-sync';
import { SyncBusyError, type ResumoSync } from '../../src/modules/sincronizacao/sync.service';
import type { FonteDadoTipo } from '../../src/generated/prisma/client';
import { app, resetDb, tokenDe } from '../helpers/db';

const resumo = (fonte: FonteDadoTipo): ResumoSync => ({ fonte, sincronizacaoId: 'x', status: 'SUCESSO', lidos: 1, inseridos: 0, atualizados: 0, ignorados: 1, comErro: 0, duracaoMs: 1 });
const executor = () => ({ executar: vi.fn(async (fontes: FonteDadoTipo[]) => fontes.map(resumo)) });
const marcarSucesso = (fonte: FonteDadoTipo) => prisma.sincronizacao.create({ data: { fonte, modo: 'INICIAL', status: 'SUCESSO', disparadaPor: 'teste' } });

describe('sincronização automática', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it('primeira vez (nunca sincronizou): importação INICIAL das três fontes, sem incremental extra', async () => {
    const sync = executor();
    const r = await cicloAutomatico(sync);
    expect(sync.executar.mock.calls).toEqual([[['HISTORICO', 'EVENTOS', 'REDTRACK'], 'INICIAL', 'auto:inicial']]);
    expect(r.map((x) => x.fonte)).toEqual(['HISTORICO', 'EVENTOS', 'REDTRACK']);
  });

  it('rotina: só EVENTOS e REDTRACK em modo INCREMENTAL (o HISTORICO é retrato mensal)', async () => {
    for (const f of ['HISTORICO', 'EVENTOS', 'REDTRACK'] as const) await marcarSucesso(f);
    const sync = executor();
    await cicloAutomatico(sync);
    expect(sync.executar.mock.calls).toEqual([[['EVENTOS', 'REDTRACK'], 'INCREMENTAL', 'auto']]);
  });

  it('fonte que nunca teve sucesso faz INICIAL e as demais seguem incrementais', async () => {
    await marcarSucesso('HISTORICO');
    await marcarSucesso('EVENTOS');
    const sync = executor();
    await cicloAutomatico(sync);
    expect(sync.executar.mock.calls).toEqual([
      [['REDTRACK'], 'INICIAL', 'auto:inicial'],
      [['EVENTOS'], 'INCREMENTAL', 'auto'],
    ]);
  });

  it('sincronização já em andamento (manual ou outro processo): propaga SyncBusyError para o ciclo adiar sem erro', async () => {
    for (const f of ['HISTORICO', 'EVENTOS', 'REDTRACK'] as const) await marcarSucesso(f);
    const ocupado = { executar: vi.fn(async () => { throw new SyncBusyError(); }) };
    await expect(cicloAutomatico(ocupado)).rejects.toBeInstanceOf(SyncBusyError);
  });

  it('o status informa a configuração da sincronização automática a quem consulta o painel', async () => {
    const leitura = await tokenDe('LEITURA');
    const r = await request(app).get('/api/v1/integracoes/sheets/status').set('Authorization', leitura);
    expect(r.status).toBe(200);
    expect(r.body.data.sincronizacaoAutomatica).toMatchObject({ ativa: false, intervaloMinutos: 60, proximaEm: null });
    expect(r.body.data.limiteDesatualizadoSegundos).toBe(300); // desligada nos testes
  });
});
