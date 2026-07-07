"use server";

import { ProspectStatus } from "@prisma/client";
import { redirect } from "next/navigation";
import { prisma } from "../../../lib/prisma";

export async function updateProspect(formData: FormData) {
  const siren = String(formData.get("siren") ?? "");
  const status = String(formData.get("status") ?? "A_ENRICHIR") as ProspectStatus;
  const notes = String(formData.get("notes") ?? "");
  const markContacted = formData.get("markContacted") === "1";

  if (!Object.values(ProspectStatus).includes(status)) {
    throw new Error("Statut invalide");
  }

  await prisma.prospect.update({
    where: { siren },
    data: {
      status,
      notes,
      contactedAt: markContacted || status === "CONTACTE" ? new Date() : undefined,
    },
  });

  redirect(`/prospects/${siren}`);
}
