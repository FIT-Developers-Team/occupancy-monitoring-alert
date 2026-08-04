// Minimal Chart.js build. `chart.js/auto` registers every controller (pie,
// radar, doughnut, bubble, polarArea, scatter) and every scale (radial,
// logarithmic, time) — this app only draws line charts, so the rest was
// shipped to the browser and never used.
import {
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from "chart.js";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Legend,
  Tooltip,
  Filler,
);

export default Chart;
