import { useEffect, useState } from "react";
import { api } from "./api";

export function DashboardClock() {
  const [now, setNow] = useState(() => new Date());
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  useEffect(() => {
    const controller = new AbortController();
    void api<{ timeZone: string }>("/salon", { signal: controller.signal })
      .then((salon) => {
        if (!controller.signal.aborted) setTimeZone(salon.timeZone);
      })
      .catch(() => {
        /* Keep the device time zone if salon settings are unavailable. */
      });
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  return (
    <time className="clique-dashboard-clock" dateTime={now.toISOString()}>
      <span>
        {new Intl.DateTimeFormat("en-PH", {
          timeZone,
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(now)}
      </span>
      <strong>
        {new Intl.DateTimeFormat("en-PH", {
          timeZone,
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        }).format(now)}
      </strong>
      {/* <small>{timeZone.replaceAll("_", " ")}</small> */}
    </time>
  );
}
