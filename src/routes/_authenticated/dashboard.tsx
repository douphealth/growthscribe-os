import { createFileRoute } from "@tanstack/react-router";
import { PortfolioControlPlane } from "@/components/dashboard/PortfolioControlPlane";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: PortfolioControlPlane,
});
