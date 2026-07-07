"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

export function ExportControls() {
  const searchParams = useSearchParams();
  const [limit, setLimit] = useState("500");

  const params = new URLSearchParams(searchParams.toString());
  params.set("limit", limit);
  const href = `/api/export?${params.toString()}`;

  return (
    <div className="exportControls">
      <select value={limit} onChange={(event) => setLimit(event.target.value)} aria-label="Nombre de prospects a exporter">
        <option value="100">100</option>
        <option value="250">250</option>
        <option value="500">500</option>
        <option value="1000">1 000</option>
        <option value="2500">2 500</option>
        <option value="5000">5 000</option>
        <option value="10000">10 000</option>
      </select>
      <a href={href} className="button secondary">
        Export CSV
      </a>
    </div>
  );
}
