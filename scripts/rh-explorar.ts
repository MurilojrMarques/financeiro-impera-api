/** Explora, só com agregados e valores NÃO pessoais, o que falta entender do RH (faixas salariais, contratos, cargos, admin_users). */
import { comRh, lerEstado } from './lib/rh-mysql';

async function main(): Promise<void> {
  await comRh(async (db) => {
    const { estado } = await lerEstado(db);
    const col = estado.colaboradores as Record<string, unknown>[];
    const conta = (k: string) => {
      const m = new Map<string, number>();
      for (const c of col) m.set(String(c[k]), (m.get(String(c[k])) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}(${n})`).join(', ');
    };
    for (const k of ['contrato', 'tipoCargo', 'cargoBase', 'funcao', 'subnivel']) console.log(`${k}:`, conta(k));
    console.log('ativos:', col.filter((c) => !c.demissao).length, 'demitidos:', col.filter((c) => c.demissao).length);
    console.log('gestorId preenchido:', col.filter((c) => c.gestorId).length, '| ids no formato:', String(col[0]!.id).replace(/[0-9a-f]/gi, 'x'));
    const cfg = estado.config as Record<string, unknown>;
    console.log('config.multiplicadorPJ =', cfg.multiplicadorPJ);
    const f = estado.faixasSalariais as Record<string, unknown>;
    for (const [dep, v] of Object.entries(f)) console.log(`faixas[${dep}]:`, JSON.stringify(v).slice(0, 380));
    const p = estado.promocoes as Record<string, unknown>[];
    console.log('promocoes datas:', p.map((x) => x.data).sort().slice(0, 1), '→', p.map((x) => x.data).sort().slice(-1));
    const [adm] = await db.query<any[]>('SELECT role, COUNT(*) n, SUM(colaborador_id IS NOT NULL AND colaborador_id <> "") com_colab FROM admin_users GROUP BY role');
    console.log('admin_users:', JSON.stringify(adm));
    const [hash] = await db.query<any[]>('SELECT LEFT(password_hash, 4) pref, LENGTH(password_hash) len, COUNT(*) n FROM admin_users GROUP BY 1,2');
    console.log('formato do hash de senha:', JSON.stringify(hash));
  });
}
main().catch((e) => { console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
