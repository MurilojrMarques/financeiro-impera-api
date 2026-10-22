import { describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ SYNC_ENABLED: true, AUTO_SYNC_ENABLED: true, AUTO_SYNC_INTERVAL_MINUTES: 60, STALE_AFTER_SECONDS: 300 }));
vi.mock('../../src/config/env', () => ({ env: envMock }));

import { limiteDesatualizadoSegundos, syncAutomaticaAtiva } from '../../src/config/sync-policy';

describe('política de "dados desatualizados" com sincronização automática', () => {
  it('com sincronização de 60 min, só é desatualizado após 90 min (1,5 × o intervalo)', () => {
    Object.assign(envMock, { SYNC_ENABLED: true, AUTO_SYNC_ENABLED: true, AUTO_SYNC_INTERVAL_MINUTES: 60 });
    expect(syncAutomaticaAtiva()).toBe(true);
    expect(limiteDesatualizadoSegundos()).toBe(5400);
  });
  it('nunca fica abaixo do limite configurado manualmente', () => {
    Object.assign(envMock, { AUTO_SYNC_INTERVAL_MINUTES: 5, STALE_AFTER_SECONDS: 3600 });
    expect(limiteDesatualizadoSegundos()).toBe(3600);
  });
  it('sem sincronização automática vale o limite de STALE_AFTER_SECONDS', () => {
    Object.assign(envMock, { AUTO_SYNC_ENABLED: false, STALE_AFTER_SECONDS: 300 });
    expect(syncAutomaticaAtiva()).toBe(false);
    expect(limiteDesatualizadoSegundos()).toBe(300);
    Object.assign(envMock, { AUTO_SYNC_ENABLED: true, SYNC_ENABLED: false });
    expect(syncAutomaticaAtiva()).toBe(false); // SYNC_ENABLED é a chave geral
  });
});
