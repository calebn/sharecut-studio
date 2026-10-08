import { expectTypeOf, it } from "vitest";
import type { DocumentCommandOptions } from "./commandQueue";

type Admitted<T> = T extends DocumentCommandOptions ? true : false;

it("requires each original identity field for replay while admitting live defaults", () => {
  expectTypeOf<
    [
      Admitted<{}>,
      Admitted<{
        replaying: true;
        client_id: string;
        command_id: string;
        client_seq: number;
      }>,
      Admitted<{ replaying: true; command_id: string; client_seq: number }>,
      Admitted<{ replaying: true; client_id: string; client_seq: number }>,
      Admitted<{ replaying: true; client_id: string; command_id: string }>,
    ]
  >().toEqualTypeOf<[true, true, false, false, false]>();
});
