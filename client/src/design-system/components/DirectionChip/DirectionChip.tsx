import { Languages } from "lucide-react";
import { Badge } from "../../primitives/Badge";

export interface DirectionChipProps {
  direction?: string;
}

function parseDirection(direction?: string): [string, string] | null {
  if (!direction) return null;
  const [from, to] = direction.split("->").map((part) => part.trim());
  if (!from || !to) return null;
  return [from, to];
}

export function DirectionChip({ direction }: DirectionChipProps) {
  const parsed = parseDirection(direction);

  if (!parsed) {
    return (
      <Badge tone="accent" icon={<Languages size={14} />}>
        Translating
      </Badge>
    );
  }

  const [from, to] = parsed;
  return (
    <Badge tone="accent">
      {from} → {to}
    </Badge>
  );
}
