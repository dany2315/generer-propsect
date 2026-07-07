"use client";

import { useFormStatus } from "react-dom";

export function ContactSearchButton({ compact = false }: { compact?: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" className={`${compact ? "smallButton" : ""} ${pending ? "loadingButton" : ""}`} disabled={pending}>
      {pending ? <span className="spinner" aria-hidden="true" /> : null}
      {pending ? "Recherche..." : compact ? "Pistes web" : "Chercher des pistes web"}
    </button>
  );
}
