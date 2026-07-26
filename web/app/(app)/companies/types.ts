// Shared between the page (server) and its controls (client), so the client
// component never imports from the page module.

export type CompanyKindFilter = "all" | "customer" | "msp";
export type CompanySort = "newest" | "oldest" | "name" | "contacts";
