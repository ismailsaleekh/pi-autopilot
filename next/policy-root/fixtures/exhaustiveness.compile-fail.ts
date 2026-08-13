type DemonstrationUnion =
  | { readonly kind: "known" }
  | { readonly kind: "added-without-handler" };

const handlers = {
  known: true,
} satisfies Readonly<Record<DemonstrationUnion["kind"], true>>;

void handlers;
