import type { Request, Response } from 'express';
import { audit } from '../../shared/services/audit.service';
import { created, noContent, ok, pageMeta, paginated } from '../../shared/utils/response';
import { usuariosService as svc } from './usuarios.service';

export async function list(req: Request, res: Response): Promise<void> {
  const q = req.valid.query;
  const { total, items } = await svc.list(q);
  paginated(res, items, pageMeta(q.page, q.limit, total));
}

export async function get(req: Request, res: Response): Promise<void> {
  ok(res, await svc.get(req.valid.params.id));
}

export async function create(req: Request, res: Response): Promise<void> {
  const u = await svc.create(req.valid.body);
  await audit(req, 'usuario.criado', 'usuario', u.id, { email: u.email, perfil: u.perfil });
  created(res, u);
}

export async function update(req: Request, res: Response): Promise<void> {
  const u = await svc.update(req.valid.params.id, req.valid.body);
  await audit(req, 'usuario.atualizado', 'usuario', u.id, req.valid.body);
  ok(res, u);
}

export async function setStatus(req: Request, res: Response): Promise<void> {
  const u = await svc.setStatus(req.user!.id, req.valid.params.id, req.valid.body.ativo);
  await audit(req, 'usuario.status', 'usuario', u.id, { ativo: u.ativo });
  ok(res, u);
}

export async function setPerfil(req: Request, res: Response): Promise<void> {
  const u = await svc.setPerfil(req.user!.id, req.valid.params.id, req.valid.body.perfil);
  await audit(req, 'usuario.perfil', 'usuario', u.id, { perfil: u.perfil });
  ok(res, u);
}

export async function remove(req: Request, res: Response): Promise<void> {
  await svc.remove(req.user!.id, req.valid.params.id);
  await audit(req, 'usuario.desativado', 'usuario', req.valid.params.id);
  noContent(res);
}
