"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "../lib/prisma";
import { discoverContactLeadsForSiren } from "../lib/contact-lead-runner";
import { SearchCooldownError, SearchQuotaExceededError } from "../lib/search-provider";

export async function discoverContactLeadsAction(formData: FormData) {
  const siren = String(formData.get("siren") ?? "").trim();
  const returnTo = String(formData.get("returnTo") ?? "/").trim() || "/";
  const forceSearch = String(formData.get("forceSearch") ?? "") === "1";

  if (!/^\d{9}$/.test(siren)) {
    throw new Error("SIREN invalide");
  }

  let redirectTarget = returnTo;

  try {
    const saved = await discoverContactLeadsForSiren(siren, { ignoreCooldown: forceSearch });
    redirectTarget = withDialog(returnTo, {
      prospectDialog: "web-search-done",
      saved: String(saved),
      forced: forceSearch ? "1" : "0",
    });
  } catch (error) {
    if (error instanceof SearchCooldownError) {
      redirectTarget = withDialog(returnTo, {
        prospectDialog: "web-search-cooldown",
        minutes: String(error.minutes),
      });
    } else if (error instanceof SearchQuotaExceededError) {
      redirectTarget = withDialog(returnTo, {
        prospectDialog: "web-search-quota",
        limit: String(error.limit),
      });
    } else {
      throw error;
    }
  }

  revalidatePath("/");
  revalidatePath(`/prospects/${siren}`);
  redirect(redirectTarget);
}

function withDialog(returnTo: string, params: Record<string, string>) {
  const url = new URL(returnTo || "/", "http://local");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
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
