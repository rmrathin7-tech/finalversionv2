import { db } from "./firebase.js";
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export async function seedWorkspaceConfig() {

  // ── DOMAIN TEMPLATES ──────────────────────────────────────────
  const domainTemplates = [
    {
      key: "manufacturing",
      label: "Manufacturing",
      cf: [
        { key: "operatingActivities",   title: "Operating Activities",   items: ["Net Profit", "Depreciation", "Interest Paid"] },
        { key: "investingActivities",   title: "Investing Activities",   items: ["Capital Expenditure", "Asset Sales"] },
        { key: "financingActivities",   title: "Financing Activities",   items: ["Bank Loan", "Equity Raised", "Dividend Paid"] }
      ],
      pnl: [
        { key: "revenue",             title: "Revenue",                      items: ["Product Revenue"] },
        { key: "directCosts",         title: "Direct Costs",                 items: ["Raw Material"] },
        { key: "employeeCosts",       title: "Employee Costs",               items: ["Salaries"] },
        { key: "otherIndirectCosts",  title: "Other Indirect Costs",         items: [] },
        { key: "financeCosts",        title: "Finance Costs",                items: [] },
        { key: "depreciation",        title: "Depreciation & Amortization",  items: [] },
        { key: "tax",                 title: "Tax",                          items: [] }
      ],
      bs: [
        { key: "nonCurrentAssets",      title: "Non Current Assets",      items: ["Property", "Equipment"] },
        { key: "currentAssets",         title: "Current Assets",          items: ["Cash", "Receivables"] },
        { key: "nonCurrentLiabilities", title: "Non Current Liabilities", items: ["Long Term Debt"] },
        { key: "currentLiabilities",    title: "Current Liabilities",     items: ["Payables"] },
        { key: "equity",                title: "Equity",                  dynamic: true, items: [] }
      ]
    }
  ];

  // ── ENTITY TYPES ───────────────────────────────────────────────
  const entityTypes = [
    { key: "pvtLtd",         label: "Private Limited",  equityItems: ["Share Capital", "Reserves"] },
    { key: "partnership",    label: "Partnership",       equityItems: ["Capital Account"] },
    { key: "proprietorship", label: "Proprietorship",    equityItems: ["Owner Capital"] }
  ];

  // ── WRITE TO FIRESTORE ─────────────────────────────────────────
  await setDoc(
    doc(db, "workspace-config", "domainTemplates"),
    { templates: domainTemplates }
  );

  await setDoc(
    doc(db, "workspace-config", "entityTypes"),
    { types: entityTypes }
  );

  console.log("✅ Seed complete. Check Firestore.");
}
