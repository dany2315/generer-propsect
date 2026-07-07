"use client";

import { useFormStatus } from "react-dom";

export function SaveSettingsButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" className={pending ? "loadingButton" : ""} disabled={pending}>
      {pending ? <span className="spinner" aria-hidden="true" /> : null}
      {pending ? "Enregistrement..." : "Enregistrer"}
    </button>
  );
}
