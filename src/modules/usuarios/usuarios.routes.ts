import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { authorize, Roles } from '../../middlewares/authorization.middleware';
import { validate } from '../../middlewares/validate.middleware';
import * as c from './usuarios.controller';
import { createBody, idParams, listQuery, perfilBody, statusBody, updateBody } from './usuarios.schemas';

export const usuariosRouter = Router();
usuariosRouter.use(authenticate(), authorize(Roles.ADMIN));

usuariosRouter.get('/', validate({ query: listQuery }), c.list);
usuariosRouter.post('/', validate({ body: createBody }), c.create);
usuariosRouter.get('/:id', validate({ params: idParams }), c.get);
usuariosRouter.patch('/:id', validate({ params: idParams, body: updateBody }), c.update);
usuariosRouter.patch('/:id/status', validate({ params: idParams, body: statusBody }), c.setStatus);
usuariosRouter.patch('/:id/perfil', validate({ params: idParams, body: perfilBody }), c.setPerfil);
usuariosRouter.delete('/:id', validate({ params: idParams }), c.remove);
