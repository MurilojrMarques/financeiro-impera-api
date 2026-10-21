import type { Prisma } from '../../generated/prisma/client';
import { cleanText, searchKey } from '../utils/text';

type Tx = Prisma.TransactionClient;

/** Resolve nomes em ids estáveis (lojas, produtos, afiliados) em lote, evitando N+1. */
export class ReferenceResolver {
  lojas = new Map<string, string>();
  produtos = new Map<string, string>();
  /** chave de busca (sem acento/minúscula) -> id do afiliado */
  afiliados = new Map<string, string>();

  constructor(private readonly tx: Tx) {}

  async preload(input: { lojas: (string | null)[]; produtos: (string | null)[]; afiliados: (string | null)[] }): Promise<void> {
    await Promise.all([
      this.loadSimple('loja', input.lojas, this.lojas),
      this.loadSimple('produto', input.produtos, this.produtos),
      this.loadAfiliados(input.afiliados),
    ]);
  }

  private async loadSimple(model: 'loja' | 'produto', names: (string | null)[], cache: Map<string, string>): Promise<void> {
    const nomes = [...new Set(names.map(cleanText).filter((n): n is string => n !== null))];
    if (nomes.length === 0) return;
    const delegate = this.tx[model] as unknown as {
      findMany(a: unknown): Promise<{ id: string; nome: string }[]>;
      createMany(a: unknown): Promise<unknown>;
    };
    const found = await delegate.findMany({ where: { nome: { in: nomes } }, select: { id: true, nome: true } });
    found.forEach((r) => cache.set(r.nome, r.id));
    const faltam = nomes.filter((n) => !cache.has(n));
    if (faltam.length > 0) {
      await delegate.createMany({ data: faltam.map((nome) => ({ nome })), skipDuplicates: true });
      const again = await delegate.findMany({ where: { nome: { in: faltam } }, select: { id: true, nome: true } });
      again.forEach((r) => cache.set(r.nome, r.id));
    }
  }

  /**
   * Afiliados: correspondência EXATA pela chave normalizada (nome ou alias cadastrado).
   * Nomes apenas parecidos NUNCA são mesclados automaticamente.
   */
  private async loadAfiliados(names: (string | null)[]): Promise<void> {
    const porChave = new Map<string, string>(); // chave -> nome original (primeiro visto)
    for (const n of names) {
      const nome = cleanText(n);
      const chave = searchKey(nome);
      if (nome && chave && !porChave.has(chave)) porChave.set(chave, nome);
    }
    const chaves = [...porChave.keys()];
    if (chaves.length === 0) return;

    const [porNome, porAlias] = await Promise.all([
      this.tx.afiliado.findMany({ where: { nomeBusca: { in: chaves } }, select: { id: true, nomeBusca: true } }),
      this.tx.afiliadoAlias.findMany({ where: { aliasBusca: { in: chaves } }, select: { afiliadoId: true, aliasBusca: true } }),
    ]);
    porAlias.forEach((a) => this.afiliados.set(a.aliasBusca, a.afiliadoId));
    porNome.forEach((a) => {
      if (!this.afiliados.has(a.nomeBusca)) this.afiliados.set(a.nomeBusca, a.id);
    });

    const faltam = chaves.filter((c) => !this.afiliados.has(c));
    if (faltam.length > 0) {
      await this.tx.afiliado.createMany({
        data: faltam.map((c) => ({ nome: porChave.get(c)!, nomeBusca: c })),
        skipDuplicates: true,
      });
      const again = await this.tx.afiliado.findMany({ where: { nomeBusca: { in: faltam } }, select: { id: true, nomeBusca: true } });
      again.forEach((a) => this.afiliados.set(a.nomeBusca, a.id));
    }
  }

  loja(nome: string | null): string | null {
    const n = cleanText(nome);
    return n ? (this.lojas.get(n) ?? null) : null;
  }

  produto(nome: string | null): string | null {
    const n = cleanText(nome);
    return n ? (this.produtos.get(n) ?? null) : null;
  }

  afiliado(nome: string | null): string | null {
    const k = searchKey(nome);
    return k ? (this.afiliados.get(k) ?? null) : null;
  }
}
