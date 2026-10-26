/**
 * Importa o RH do sistema atual (MySQL impera_rh · app_state) para as tabelas relacionais do PostgreSQL desta API.
 * SOMENTE LEITURA na origem. Repetível: usa o id do sistema atual como chave (`legadoId`), então rodar de novo atualiza, não duplica.
 *
 * Uso:
 *   npm run rh:importar              → simulação (não grava nada; mostra contagens e avisos)
 *   npm run rh:importar -- --aplicar → grava
 *
 * Nunca imprime dados pessoais nem salários: só contagens e avisos por posição.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RhTipoMovimentacao } from '../src/generated/prisma/client';
import { closeDatabase, prisma } from '../src/config/database';
import { fotosDir } from '../src/modules/rh/rh.storage';
import { comRh, lerEstado } from './lib/rh-mysql';

type Obj = Record<string, unknown>;
const aplicar = process.argv.includes('--aplicar');
const avisos: string[] = [];
const aviso = (m: string): void => {
  avisos.push(m);
};

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const centavos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null);

/** Aceita AAAA-MM-DD (com ou sem hora) e DD/MM/AAAA. */
function data(v: unknown, rotulo: string): Date | null {
  const s = str(v);
  if (!s) return null;
  let m: string[] | null = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) {
    const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    m = br ? [br[0], br[3]!, br[2]!, br[1]!] : null;
  }
  if (!m) {
    aviso(`data inválida em ${rotulo}`);
    return null;
  }
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    aviso(`data inválida em ${rotulo}`);
    return null;
  }
  return d;
}

const FOTOS = fotosDir();

async function salvarFoto(id: string, base64: string | null): Promise<string | null> {
  if (!base64) return null;
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(base64);
  if (!m) {
    aviso('foto em formato não reconhecido (ignorada)');
    return null;
  }
  const ext = m[1]!.toLowerCase().replace('jpeg', 'jpg');
  const buf = Buffer.from(m[2]!, 'base64');
  if (buf.length === 0 || buf.length > 2_000_000) {
    aviso('foto vazia ou grande demais (ignorada)');
    return null;
  }
  const nome = `${id}.${ext}`;
  if (aplicar) {
    await mkdir(FOTOS, { recursive: true });
    await writeFile(path.join(FOTOS, nome), buf);
  }
  return nome;
}

async function main(): Promise<void> {
  const { estado, atualizadoEm, admins } = await comRh(async (db) => {
    const lido = await lerEstado(db);
    const [rows] = await db.query<import('mysql2/promise').RowDataPacket[]>('SELECT id, username, email, role, departamento, colaborador_id FROM admin_users');
    return { ...lido, admins: rows };
  });
  const colabs = (estado.colaboradores ?? []) as Obj[];
  const promos = (estado.promocoes ?? []) as Obj[];
  const faixas = (estado.faixasSalariais ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  console.log(`${aplicar ? 'APLICANDO' : 'SIMULAÇÃO'} — origem atualizada em ${atualizadoEm?.toISOString() ?? '?'}: ${colabs.length} colaboradores, ${promos.length} promoções/reajustes, ${admins.length} usuários`);

  // 1) colaboradores (sem gestor), depois o vínculo com o gestor
  const idPorLegado = new Map<string, string>();
  let criados = 0;
  let atualizados = 0;
  for (const [i, c] of colabs.entries()) {
    const legadoId = str(c.id);
    const nome = str(c.nome);
    const salario = centavos(c.salario);
    if (!legadoId || !nome || salario === null) {
      aviso(`colaborador #${i + 1} ignorado (sem id, nome ou salário)`);
      continue;
    }
    const existente = await prisma.rhColaborador.findUnique({ where: { legadoId }, select: { id: true } });
    const id = existente?.id ?? crypto.randomUUID();
    const dados = {
      nome,
      email: str(c.email)?.toLowerCase() ?? null,
      celular: str(c.celular),
      nascimento: data(c.nascimento, `colaborador #${i + 1} nascimento`),
      cnpj: str(c.cnpj),
      endereco: str(c.endereco),
      camiseta: str(c.camiseta),
      departamento: str(c.departamento) ?? 'Sem departamento',
      cargoBase: str(c.cargoBase),
      funcao: str(c.funcao),
      tipoCargo: str(c.tipoCargo),
      senioridade: str(c.senioridade),
      subnivel: int(c.subnivel),
      inicio: data(c.inicio, `colaborador #${i + 1} início`),
      demissao: data(c.demissao, `colaborador #${i + 1} demissão`),
      motivoDemissao: str(c.motivoDemissao),
      contratoObs: str(c.contrato),
      salarioCentavos: salario,
      descricao: str(c.descricao),
      obsCargo: str(c.obsCargo),
      discordUserId: str(c.discordUserId),
      fotoArquivo: await salvarFoto(id, str(c.foto)),
    };
    idPorLegado.set(legadoId, id);
    if (existente) atualizados++;
    else criados++;
    if (aplicar) await prisma.rhColaborador.upsert({ where: { legadoId }, create: { id, legadoId, ...dados }, update: dados });
  }
  let comGestor = 0;
  for (const c of colabs) {
    const legadoId = str(c.id);
    const gestorLegado = str(c.gestorId);
    if (!legadoId || !idPorLegado.has(legadoId)) continue;
    if (gestorLegado && !idPorLegado.has(gestorLegado)) aviso('gestor referenciado não existe na lista de colaboradores');
    const gestorId = gestorLegado ? (idPorLegado.get(gestorLegado) ?? null) : null;
    if (gestorId) comGestor++;
    if (aplicar) await prisma.rhColaborador.update({ where: { legadoId }, data: { gestorId } });
  }
  console.log(`colaboradores: ${criados} novos, ${atualizados} atualizados, ${comGestor} com gestor`);

  // 2) promoções e reajustes
  let movs = 0;
  for (const [i, p] of promos.entries()) {
    const legadoId = str(p.id);
    const colaboradorLegado = str(p.colaboradorId);
    const colaboradorId = colaboradorLegado ? idPorLegado.get(colaboradorLegado) : undefined;
    const d = data(p.data, `movimentação #${i + 1}`);
    const anterior = centavos(p.salarioAnterior);
    const novo = centavos(p.salarioNovo);
    if (!legadoId || !colaboradorId || !d || anterior === null || novo === null) {
      aviso(`movimentação #${i + 1} ignorada (sem id, colaborador, data ou salários)`);
      continue;
    }
    const tipoBruto = str(p.tipo);
    const cargoMudou = str(p.cargoNovo) !== str(p.cargoAnterior);
    const tipo: RhTipoMovimentacao = tipoBruto === 'promocao' ? 'PROMOCAO' : tipoBruto === 'reajuste' ? 'REAJUSTE' : cargoMudou ? 'PROMOCAO' : 'REAJUSTE';
    if (!tipoBruto) aviso(`movimentação #${i + 1} sem tipo: classificada como ${tipo} pelo cargo`);
    const dados = {
      colaboradorId,
      tipo,
      data: d,
      cargoAnterior: str(p.cargoAnterior),
      cargoNovo: str(p.cargoNovo),
      departamentoAnterior: str(p.departamentoAnterior),
      departamentoNovo: str(p.departamentoNovo),
      senioridadeAnterior: str(p.senioridadeAnterior),
      senioridadeNova: str(p.senioridadeNova),
      subnivelAnterior: int(p.subnivelAnterior),
      subnivelNovo: int(p.subnivelNovo),
      salarioAnteriorCentavos: anterior,
      salarioNovoCentavos: novo,
      obs: str(p.obs),
    };
    movs++;
    if (aplicar) await prisma.rhMovimentacao.upsert({ where: { legadoId }, create: { legadoId, ...dados }, update: dados });
  }
  console.log(`movimentações: ${movs}`);

  // 3) matriz de cargos e salários
  let nFaixas = 0;
  for (const [departamento, cargos] of Object.entries(faixas)) {
    for (const [cargo, niveis] of Object.entries(cargos ?? {})) {
      for (const [nivel, valor] of Object.entries(niveis ?? {})) {
        const v = centavos(valor);
        if (v === null) continue; // nível não existe para o cargo (null)
        nFaixas++;
        if (aplicar) await prisma.rhFaixaSalarial.upsert({ where: { departamento_cargo_nivel: { departamento, cargo, nivel } }, create: { departamento, cargo, nivel, valorCentavos: v }, update: { valorCentavos: v } });
      }
    }
  }
  console.log(`faixas salariais: ${nFaixas}`);

  // 4) usuários do sistema atual (sem senha): só o vínculo papel × colaborador
  let nAdm = 0;
  for (const a of admins) {
    const colab = a.colaborador_id ? idPorLegado.get(String(a.colaborador_id)) : undefined;
    if (a.colaborador_id && !colab) aviso(`usuário legado ${a.id} aponta para colaborador inexistente`);
    nAdm++;
    const dados = { username: String(a.username), email: a.email ? String(a.email).toLowerCase() : null, papel: String(a.role), departamento: a.departamento ? String(a.departamento) : null, colaboradorId: colab ?? null };
    if (aplicar) await prisma.rhUsuarioLegado.upsert({ where: { legadoId: Number(a.id) }, create: { legadoId: Number(a.id), ...dados }, update: dados });
  }
  console.log(`usuários legados: ${nAdm} (sem senhas)`);

  // 5) conferência: o salário atual de cada pessoa deve bater com o último reajuste registrado
  if (aplicar) {
    const ultimos = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint n FROM rh_colaboradores c
      JOIN LATERAL (SELECT "salarioNovoCentavos" s FROM rh_movimentacoes m WHERE m."colaboradorId" = c.id ORDER BY m.data DESC, m."criadoEm" DESC LIMIT 1) u ON true
      WHERE u.s <> c."salarioCentavos"`;
    console.log(`conferência: ${Number(ultimos[0]?.n ?? 0)} colaborador(es) com salário atual diferente do último reajuste registrado`);
  }

  if (avisos.length) {
    const resumo = new Map<string, number>();
    for (const a of avisos) resumo.set(a, (resumo.get(a) ?? 0) + 1);
    console.log(`\navisos (${avisos.length}):`);
    for (const [a, n] of resumo) console.log(`  - ${a}${n > 1 ? ` (x${n})` : ''}`);
  }
  if (!aplicar) console.log('\nNada foi gravado. Rode com --aplicar para gravar.');
}

main()
  .catch((e) => {
    console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
