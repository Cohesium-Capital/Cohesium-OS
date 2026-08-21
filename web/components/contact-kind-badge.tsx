import { Building2, Handshake, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// The one visual encoding for which track a contact belongs to, used on every
// contact surface (review grid, grade card, send queue). Acquisition targets
// read "hot" (brand-tinted); customers read neutral; referral partners read
// distinct from both, because approving a draft to one is a different decision
// — it proposes a business relationship rather than asking for their read on a
// market. Keep the encoding identical everywhere or it stops carrying meaning.
export function ContactKindBadge({ kind }: { kind: string | null }) {
  if (kind === "msp") {
    // Outline base, then tint: the default variant would drag in the brand
    // gradient's elevation shadow, which reads as a control instead of a label.
    return (
      <Badge variant="outline" className="border-transparent bg-primary/10 text-primary">
        <Target /> MSP target
      </Badge>
    );
  }
  if (kind === "customer") {
    return (
      <Badge variant="outline">
        <Building2 /> Customer
      </Badge>
    );
  }
  if (kind === "advisor") {
    return (
      <Badge variant="outline" className="border-transparent bg-amber-500/10 text-amber-700 dark:text-amber-400">
        <Handshake /> Referral partner
      </Badge>
    );
  }
  return null;
}
