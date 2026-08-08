import { Network } from "./Network.js";
import { NetworkId } from "./NetworkTypes.js";

export default class FhenixHeliumNetwork extends Network {
  constructor() {
    super(
      NetworkId.Fhenix_Helium,
      "Fhenix Helium",
      "https://api.helium.fhenix.zone",
      ""
    );
  }
}
