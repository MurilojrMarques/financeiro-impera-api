import { auditoriaQuery } from '../modules/admin/admin.routes';
import { afiliadosQuery, regraBody as afiliadoRegraBody } from '../modules/afiliados/afiliados.routes';
import { changePasswordBody, forgotPasswordBody, loginBody, refreshBody, resetPasswordBody, tokenBody } from '../modules/auth/auth.schemas';
import { patchBody, regraBody as classRegraBody, simularBody } from '../modules/classificacoes/classificacoes.routes';
import {
  atualizarCategoriaBody, atualizarCustoBody, criarCategoriaBody, criarCustoBody, criarRecorrenciaBody, listaQuery as custosListaQuery,
} from '../modules/custos/custos.schemas';
import { evolucaoQuery, opcoesQuery } from '../modules/dashboard/dashboard.routes';
import { atualizarRegraBody, criarRegraBody } from '../modules/financeiro/financeiro.routes';
import { redtrackQuery } from '../modules/redtrack/redtrack.routes';
import { pagina } from '../modules/sincronizacao/sincronizacao.routes';
import { createBody, listQuery, perfilBody, statusBody, updateBody } from '../modules/usuarios/usuarios.schemas';
import { filtrosBase } from '../shared/validators/filtros';
import { z } from 'zod';

/** Reexporta os schemas Zod REAIS das rotas: a documentação é gerada deles (sem cópia manual). */
export const adminRoutesSchemas = {
  filtros: filtrosBase,
  login: loginBody,
  refresh: refreshBody,
  changePassword: changePasswordBody,
  forgotPassword: forgotPasswordBody,
  token: tokenBody,
  resetPassword: resetPasswordBody,
  usuariosLista: listQuery,
  usuariosCriar: createBody,
  usuariosAtualizar: updateBody,
  usuariosStatus: statusBody,
  usuariosPerfil: perfilBody,
  dashOpcoes: opcoesQuery,
  dashEvolucao: evolucaoQuery,
  afiliadosLista: afiliadosQuery,
  afiliadoAlias: z.object({ alias: z.string().min(2).max(120) }),
  afiliadoRegra: afiliadoRegraBody,
  redtrack: redtrackQuery,
  custosLista: custosListaQuery,
  custoCriar: criarCustoBody,
  custoAtualizar: atualizarCustoBody,
  categoriaCriar: criarCategoriaBody,
  categoriaAtualizar: atualizarCategoriaBody,
  recorrenciaCriar: criarRecorrenciaBody,
  regraCustoCriar: criarRegraBody,
  regraCustoAtualizar: atualizarRegraBody,
  classRegra: classRegraBody,
  classPatch: patchBody,
  classSimular: simularBody,
  syncPagina: pagina,
  syncBody: z.object({ fonte: z.enum(['HISTORICO', 'EVENTOS', 'REDTRACK']).optional() }),
  auditoria: auditoriaQuery,
};
