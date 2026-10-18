/** Electrical declaration identifiers, never filesystem paths. Vendor libraries
 * use slash qualifications such as TL431/TI and TLC1078/101/TI. Keep their
 * original identity across declarations, instances, saves and netlist export. */
export const spiceModelName = /^(?=.{1,40}$)[a-z0-9_][a-z0-9_.-]*(?:\/[a-z0-9_][a-z0-9_.-]*)*$/i
