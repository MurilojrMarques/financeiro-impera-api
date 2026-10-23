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
  const u = await svc.create(req.user!.id, req.valid.body);
  await audit(req, 'usuario.criado', 'usuario', u.id, { email: u.email, usuario: u.usuario, perfil: u.perfil, convite: u.conviteEnviado });
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

export async function reenviarConvite(req: Request, res: Response): Promise<void> {
  const enviado = await svc.enviarConvite(req.user!.id, req.valid.params.id);
  await audit(req, 'usuario.convite_reenviado', 'usuario', req.valid.params.id, { enviado });
  ok(res, { enviado });
}

export async function redefinirSenha(req: Request, res: Response): Promise<void> {
  const enviado = await svc.enviarRedefinicao(req.valid.params.id);
  await audit(req, 'usuario.redefinicao_enviada', 'usuario', req.valid.params.id, { enviado });
  ok(res, { enviado });
}

export async function desbloquear(req: Request, res: Response): Promise<void> {
  const u = await svc.desbloquear(req.valid.params.id);
  await audit(req, 'usuario.desbloqueado', 'usuario', u.id);
  ok(res, u);
}
