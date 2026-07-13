// Phase 3 reconciliation marker: the authenticated landing page is the portfolio control plane.
import { createFileRoute } from "@tanstack/react-router";
import { PortfolioControlPlane } from "@/components/dashboard/PortfolioControlPlane";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: PortfolioControlPlane,
});
