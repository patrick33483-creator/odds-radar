import { describe, expect, it } from "vitest";
import { parseTitanCorners } from "../server/providers/titan-corners";

/** Shape observed on a real titan007 detail page (live.titan007.com/detail/<id>cn.htm). */
const page = (stat: string): string =>
  `<script type="text/javascript">var scheduleID = 2962613; var state = 3;\n`
  + `var teamTvStatisticData = "${stat}"\n</script>`;

describe("parseTitanCorners", () => {
  it("reads full-match corners from stat code 0", () => {
    const parsed = parseTitanCorners(
      page("0,5,1,83,17^2,2,4,33,67^4,12,10,55,45^11,50%,50%,50,50"),
      "2962613",
    );
    expect(parsed).toEqual({
      titanId: "2962613",
      homeCorners: 5,
      awayCorners: 1,
      cornersTotal: 6,
    });
  });

  it("keeps a genuine nil-nil corner count", () => {
    expect(parseTitanCorners(page("0,0,0,50,50"), "1")).toMatchObject({ cornersTotal: 0 });
  });

  it("does not confuse another statistic for corners", () => {
    // Code 4 is 射門; a page without code 0 has no corner statistic at all.
    expect(parseTitanCorners(page("2,2,4,33,67^4,12,10,55,45"), "1")).toBeNull();
  });

  it("returns null when the page carries no statistics block", () => {
    expect(parseTitanCorners("<html>var scheduleID = 1;</html>", "1")).toBeNull();
  });

  it("rejects non-integer and negative counts rather than storing junk", () => {
    expect(parseTitanCorners(page("0,,,0,0"), "1")).toBeNull();
    expect(parseTitanCorners(page("0,-1,3,0,0"), "1")).toBeNull();
  });

  it("adds home and away rather than trusting a single total", () => {
    expect(parseTitanCorners(page("0,7,9,44,56"), "1")).toMatchObject({ cornersTotal: 16 });
  });
});
