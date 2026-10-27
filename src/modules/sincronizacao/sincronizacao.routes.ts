import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { GoogleSheetsClient } from '../../integrations/google-sheets/google-sheets.client';
import { GoogleSheetsService } from '../../integrations/google-sheets/google-sheets.service';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { limiteDesatualizadoSegundos } from '../../config/sync-policy';
import { estadoSyncAutomatica } from '../../jobs/auto-sync';
import { syncTriggerLimiter } from '../../middlewares/rate-limit.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { Errors } from '../../shared/errors/app-error';
import { audit } from '../../shared/services/audit.service';
import { ok, pageMeta, paginated } from '../../shared/utils/response';
import { sanitizeError } from '../../shared/utils/text';
import { SyncService } from './sync.service';

export const sincronizacaoRouter = Router();
sincronizacaoRouter.use(authenticate());

const FONTES = ['HISTORICO', 'EVENTOS', 'REDTRACK'] as const;
export const pagina = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  fonte: z.enum(FONTES).optional(),
});

let syncSingleton: SyncService | null = null;
/** Criado sob demanda: a API só precisa de credenciais Google se alguém acionar a sincronização manual. */
const sync = (): SyncService => {
  try {
    return (syncSingleton ??= new SyncService(new GoogleSheetsService(new GoogleSheetsClient())));
  } catch {
    throw Errors.unavailable('Integração com Google Sheets não configurada');
  }
};

/** Permite injetar o serviço (testes). */
export function setSyncService(service: SyncService | null): void {
  syncSingleton = service;
}

/** Disponível a quem consulta o dashboard: informa se os dados estão atualizados (sem mensagens de erro). */
sincronizacaoRouter.get('/status', authorize(Roles.LEITURA), async (req, res) => {
  const [fontes, emExecucao] = await Promise.all([
    prisma.fonteDados.findMany({ orderBy: { tipo: 'asc' } }),
    prisma.sincronizacao.findFirst({ where: { status: 'EXECUTANDO' }, select: { fonte: true, iniciadaEm: true } }),
  ]);
  const detalhado = req.user!.perfil === 'ADMIN' || req.user!.perfil === 'FINANCEIRO';
  const eventos = fontes.find((f) => f.tipo === 'EVENTOS');
  const limite = limiteDesatualizadoSegundos() * 1000;
  const eventosAtualizado = !!eventos?.ultimoSucessoEm && Date.now() - eventos.ultimoSucessoEm.getTime() <= limite;
  const algumErro = fontes.some((f) => !['ATUALIZADA', 'ATUALIZADA_COM_ERROS', 'NUNCA_SINCRONIZADA'].includes(f.estado));
  ok(res, {
    estado: !eventos ? 'NUNCA_SINCRONIZADO' : eventosAtualizado ? 'ATUALIZADO' : algumErro ? 'ERRO' : 'DESATUALIZADO',
    dadosDesatualizados: !eventosAtualizado,
    ultimaSincronizacao: eventos?.ultimoSucessoEm ?? null,
    sincronizandoAgora: emExecucao ? { fonte: emExecucao.fonte, desde: emExecucao.iniciadaEm } : null,
    limiteDesatualizadoSegundos: limiteDesatualizadoSegundos(),
    sincronizacaoAutomatica: {
      ativa: estadoSyncAutomatica.ativa,
      intervaloMinutos: env.AUTO_SYNC_INTERVAL_MINUTES,
      eventosIntervaloSegundos: env.AUTO_SYNC_EVENTOS_INTERVAL_SECONDS,
      eventosUltimaEm: estadoSyncAutomatica.eventosUltimaEm,
      eventosUltimoResultado: estadoSyncAutomatica.eventosUltimoResultado,
      proximaEm: estadoSyncAutomatica.proximaEm,
      ultimaTentativaEm: estadoSyncAutomatica.ultimaTentativaEm,
      ultimoResultado: estadoSyncAutomatica.ultimoResultado,
    },
    fontes: fontes.map((f) => ({
      fonte: f.tipo,
      estado: f.estado,
      ultimoSucessoEm: f.ultimoSucessoEm,
      ultimaLeituraEm: f.ultimaLeituraEm,
      intervaloSegundos: f.intervaloSegundos,
      ...(detalhado ? { ultimoErro: f.ultimoErro } : {}),
    })),
  });
});

const admin = authorize(Roles.ADMIN);

sincronizacaoRouter.get('/execucoes', admin, validate({ query: pagina }), async (req, res) => {
  const { page, limit, fonte } = req.valid.query;
  const where = fonte ? { fonte } : {};
  const [total, items] = await Promise.all([
    prisma.sincronizacao.count({ where }),
    prisma.sincronizacao.findMany({ where, orderBy: { iniciadaEm: 'desc' }, skip: (page - 1) * limit, take: limit, select: {
      id: true, fonte: true, modo: true, status: true, iniciadaEm: true, finalizadaEm: true, duracaoMs: true, lidos: true,
      inseridos: true, atualizados: true, ignorados: true, comErro: true, erro: true, disparadaPor: true,
    } }),
  ]);
  paginated(res, items, pageMeta(page, limit, total));
});

sincronizacaoRouter.get('/erros', admin, validate({ query: pagina }), async (req, res) => {
  const { page, limit, fonte } = req.valid.query;
  const where = fonte ? { fonte } : {};
  const [total, items] = await Promise.all([
    prisma.erroImportacao.count({ where }),
    prisma.erroImportacao.findMany({ where, orderBy: { criadoEm: 'desc' }, skip: (page - 1) * limit, take: limit, select: {
      id: true, fonte: true, linhaOrigem: true, codigo: true, campo: true, mensagem: true, criadoEm: true, sincronizacaoId: true,
    } }),
  ]);
  paginated(res, items, pageMeta(page, limit, total));
});

sincronizacaoRouter.get('/fontes', admin, async (_req, res) => {
  const [fontes, cursores] = await Promise.all([prisma.fonteDados.findMany({ orderBy: { tipo: 'asc' } }), prisma.sincronizacaoCursor.findMany()]);
  const cur = new Map(cursores.map((c) => [c.fonte, c]));
  ok(
    res,
    fontes.map((f) => ({
      fonte: f.tipo,
      aba: f.nomeAba,
      estado: f.estado,
      intervaloSegundos: f.intervaloSegundos,
      ultimoSucessoEm: f.ultimoSucessoEm,
      cabecalhosReconhecidos: f.cabecalhos,
      cabecalhosOpcionaisAusentes: f.cabecalhosAusentes,
      cursorUltimaLinha: cur.get(f.tipo)?.ultimaLinha ?? 0,
    })),
  );
});

// credenciais e IDs da planilha nunca são retornados por nenhuma rota

const disparar = (modo: 'INCREMENTAL' | 'COMPLETA', acao: string) =>
  [
    admin,
    syncTriggerLimiter,
    validate({ body: z.object({ fonte: z.enum(FONTES).optional() }).default({}) }),
    async (req: import('express').Request, res: import('express').Response) => {
      const fontes = req.valid.body.fonte ? [req.valid.body.fonte] : [...FONTES];
      const exec = await sync().iniciar(fontes, modo, `manual:${req.user!.id}`); // 409 se já houver sincronização
      exec.concluida.catch((err) => logger.error({ msg: sanitizeError(err) }, 'sincronização manual falhou'));
      await audit(req, acao, 'sincronizacao', undefined, { fontes, modo });
      res.status(202).json({ success: true, data: { aceita: true, fontes, modo } });
    },
  ] as const;

sincronizacaoRouter.post('/sincronizar', ...disparar('INCREMENTAL', 'integracao.sincronizar'));
sincronizacaoRouter.post('/reconciliar', ...disparar('COMPLETA', 'integracao.reconciliar'));
