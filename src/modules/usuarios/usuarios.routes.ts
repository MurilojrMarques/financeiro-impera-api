import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { emailActionLimiter } from '../../middlewares/rate-limit.middleware';
import { validate } from '../../middlewares/validate.middleware';
import * as c from './usuarios.controller';
import { createBody, idParams, listQuery, perfilBody, rhBody, statusBody, updateBody } from './usuarios.schemas';

export const usuariosRouter = Router();
usuariosRouter.use(authenticate(), authorize(Roles.ADMIN));

usuariosRouter.get('/', validate({ query: listQuery }), c.list);
usuariosRouter.post('/', validate({ body: createBody }), c.create);
usuariosRouter.get('/:id', validate({ params: idParams }), c.get);
usuariosRouter.patch('/:id', validate({ params: idParams, body: updateBody }), c.update);
usuariosRouter.patch('/:id/status', validate({ params: idParams, body: statusBody }), c.setStatus);
usuariosRouter.patch('/:id/perfil', validate({ params: idParams, body: perfilBody }), c.setPerfil);
usuariosRouter.patch('/:id/rh', validate({ params: idParams, body: rhBody }), c.setRh);
usuariosRouter.delete('/:id', validate({ params: idParams }), c.remove);
usuariosRouter.post('/:id/reenviar-convite', emailActionLimiter, validate({ params: idParams }), c.reenviarConvite);
usuariosRouter.post('/:id/redefinir-senha', emailActionLimiter, validate({ params: idParams }), c.redefinirSenha);
usuariosRouter.post('/:id/desbloquear', validate({ params: idParams }), c.desbloquear);
