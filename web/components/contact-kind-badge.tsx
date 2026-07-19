import { Building2, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// The one visual encoding for the MSP-vs-customer distinction, used on every
// contact surface (review grid, grade card, send queue). MSP acquisition
// targets read "hot" (brand-tinted); customer contacts read neutral. Keep the
// encoding identical everywhere or it stops carrying meaning.
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
  return null;
}
