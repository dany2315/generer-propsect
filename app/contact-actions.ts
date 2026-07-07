"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "../lib/prisma";
import { discoverContactLeadsForSiren } from "../lib/contact-lead-runner";

export async function discoverContactLeadsAction(formData: FormData) {
  const siren = String(formData.get("siren") ?? "").trim();
  const returnTo = String(formData.get("returnTo") ?? "/").trim() || "/";

  if (!/^\d{9}$/.test(siren)) {
    throw new Error("SIREN invalide");
  }

  await discoverContactLeadsForSiren(siren);
  revalidatePath("/");
  revalidatePath(`/prospects/${siren}`);
  redirect(returnTo);
}

export async function deleteContactLeadAction(formData: FormData) {
  const leadId = String(formData.get("leadId") ?? "").trim();
  const siren = String(formData.get("siren") ?? "").trim();
  const returnTo = String(formData.get("returnTo") ?? `/prospects/${siren}`).trim() || `/prospects/${siren}`;

  if (!leadId || !/^\d{9}$/.test(siren)) {
    throw new Error("Piste invalide");
  }

  await prisma.$executeRaw`
    DELETE FROM contact_leads
    WHERE id = ${leadId}
      AND prospect_siren = ${siren}
  `;
  revalidatePath("/");
  revalidatePath(`/prospects/${siren}`);
  redirect(returnTo);
}

export async function markProspectHasProspectingDataAction(formData: FormData) {
  const siren = String(formData.get("siren") ?? "").trim();
  const returnTo = String(formData.get("returnTo") ?? `/prospects/${siren}`).trim() || `/prospects/${siren}`;

  if (!/^\d{9}$/.test(siren)) {
    throw new Error("SIREN invalide");
  }

  await prisma.prospect.update({
    where: { siren },
    data: {
      status: "A_CONTACTER",
    },
  });
  revalidatePath("/");
  revalidatePath(`/prospects/${siren}`);
  redirect(returnTo);
}

export async function updateContactLeadStatusAction(formData: FormData) {
  const leadId = String(formData.get("leadId") ?? "").trim();
  const siren = String(formData.get("siren") ?? "").trim();
  const returnTo = String(formData.get("returnTo") ?? `/prospects/${siren}`).trim() || `/prospects/${siren}`;
  const status = String(formData.get("status") ?? "TO_VERIFY").trim();

  if (!leadId || !/^\d{9}$/.test(siren) || !["KEPT", "TO_VERIFY"].includes(status)) {
    throw new Error("Piste invalide");
  }

  await prisma.$executeRaw`
    UPDATE contact_leads
    SET status = ${status},
        updated_at = now()
    WHERE id = ${leadId}
      AND prospect_siren = ${siren}
  `;

  revalidatePath("/");
  revalidatePath(`/prospects/${siren}`);
  redirect(returnTo);
}
