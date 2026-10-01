// A "logo" do DocDrop é só o nome escrito, em tons neutros (modelo "Puro", escolhido pelo dono em
// 2026-10-01): "doc" leve em cinza, "drop" firme em grafite. Sem símbolo e sem a cor da marca: o
// contraste de peso separa o que você prepara (doc) da entrega (drop).

/** Tamanho vem da fonte do lugar onde a logo entra (text-base no menu, text-2xl na entrada…). */
export function Logo({ className = '' }: { className?: string }) {
  return <span role="img" aria-label="DocDrop" className={`inline-flex select-none items-baseline whitespace-nowrap lowercase leading-none tracking-tight ${className}`}>
    <span aria-hidden className="font-normal text-slate-400">doc</span><span aria-hidden className="font-semibold text-ink">drop</span>
  </span>;
}
