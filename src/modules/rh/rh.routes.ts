import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { colaboradoresRouter } from './colaboradores.routes';
import { documentosRouter } from './documentos.routes';
import { folhaRouter } from './folha.routes';
import { monitoramentoRouter } from './monitoramento.routes';
import { exigeRh } from './rh.access';

/** Módulo de RH (PJ). Exige login e um papel de RH (RH, CEO, GESTOR ou COLABORADOR): ADMIN/FINANCEIRO do financeiro não entram sem ele. */
export const rhRouter = Router();
rhRouter.use(authenticate(), exigeRh());

rhRouter.use('/', monitoramentoRouter);
rhRouter.use('/colaboradores', colaboradoresRouter);
rhRouter.use('/folha', folhaRouter);
rhRouter.use('/documentos', documentosRouter);
