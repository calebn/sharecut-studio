import { type RefObject, useLayoutEffect, useState } from "react";
import type { Bounds } from "../stages/edit/createMenuLayout";
import { DetentMark } from "./DetentMark";
import type {
  ChooserView,
  CreateView,
  DetentView,
  HitRouter,
} from "./hitRouting";
import { TimelineChooser } from "./TimelineChooser";
import { TimelineCreateMenu } from "./TimelineCreateMenu";
import type { CreateMenuPlace } from "./touchGrammar";
import { visibleBox } from "./visibleBox";

type Measurement = {
  scroller: HTMLDivElement | null;
  lanes: HTMLDivElement | null;
  bounds: Bounds;
  detentBounds: Bounds;
};

function sameBounds(a: Bounds, b: Bounds): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom
  );
}

type Props = {
  scrollerRef: RefObject<HTMLDivElement | null>;
  lanesRef: RefObject<HTMLDivElement | null>;
  chooser: ChooserView | null;
  create: { view: CreateView; place: CreateMenuPlace } | null;
  detent: DetentView | null;
  router: HitRouter | null;
  phone: boolean;
};

export function TimelinePhysicalOverlays(props: Props) {
  const { chooser, create, detent, router, phone, scrollerRef, lanesRef } =
    props;
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  useLayoutEffect(() => {
    if (
      !(
        (props.chooser && props.router) ||
        (props.create && props.router && !props.phone) ||
        props.detent
      )
    ) {
      return;
    }
    const scroller = scrollerRef.current;
    const lanes = lanesRef.current;
    const bounds = visibleBox(scroller);
    const detentBounds = visibleBox(lanes ?? scroller);
    if (
      !measurement ||
      measurement.scroller !== scroller ||
      measurement.lanes !== lanes ||
      !sameBounds(measurement.bounds, bounds) ||
      !sameBounds(measurement.detentBounds, detentBounds)
    ) {
      setMeasurement({ scroller, lanes, bounds, detentBounds });
    }
  }, [props, measurement, scrollerRef, lanesRef]);
  return (
    <>
      {chooser && router && measurement ? (
        <TimelineChooser
          view={chooser}
          router={router}
          bounds={measurement.bounds}
        />
      ) : null}
      {create && router ? (
        phone ? (
          <TimelineCreateMenu
            view={create.view}
            place={create.place}
            router={router}
            phone
          />
        ) : measurement ? (
          <TimelineCreateMenu
            view={create.view}
            place={create.place}
            router={router}
            bounds={measurement.bounds}
            avoidX={null}
            phone={false}
          />
        ) : null
      ) : null}
      {detent && measurement ? (
        <DetentMark detent={detent} bounds={measurement.detentBounds} />
      ) : null}
    </>
  );
}
