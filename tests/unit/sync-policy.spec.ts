import { describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ SYNC_ENABLED: true, AUTO_SYNC_ENABLED: true, AUTO_SYNC_EVENTOS_INTERVAL_SECONDS: 120, STALE_AFTER_SECONDS: 300 }));
vi.mock('../../src/config/env', () => ({ env: envMock }));

import { limiteDesatualizadoSegundos, syncAutomaticaAtiva } from '../../src/config/sync-policy';

describe('política de "dados desatualizados" com sincronização automática', () => {
  it('a Pagah é lida a cada 2 min: o piso de 5 min (STALE_AFTER_SECONDS) manda, porque 1,5 × 2 min é menos que isso', () => {
    Object.assign(envMock, { SYNC_ENABLED: true, AUTO_SYNC_ENABLED: true, AUTO_SYNC_EVENTOS_INTERVAL_SECONDS: 120 });
    expect(syncAutomaticaAtiva()).toBe(true);
    expect(limiteDesatualizadoSegundos()).toBe(300);
  });
  it('com leitura mais espaçada (10 min), só é desatualizado após 15 min (1,5 × o intervalo)', () => {
    Object.assign(envMock, { AUTO_SYNC_EVENTOS_INTERVAL_SECONDS: 600 });
    expect(limiteDesatualizadoSegundos()).toBe(900);
  });
  it('nunca fica abaixo do limite configurado manualmente', () => {
    Object.assign(envMock, { AUTO_SYNC_EVENTOS_INTERVAL_SECONDS: 60, STALE_AFTER_SECONDS: 3600 });
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
