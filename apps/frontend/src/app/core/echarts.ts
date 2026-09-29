import { BarChart, LineChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

/**
 * The ECharts build the app actually uses, instead of the full `echarts`
 * package (~1.1 MB raw, ~310 kB over the wire, nearly all of it chart types
 * nothing here draws). Loaded lazily by `provideEchartsCore` in app.config.
 *
 * A chart type or component missing here does not fail the build; ECharts
 * drops it at runtime and logs "... is used but not imported" in dev mode.
 * So a new chart that uses anything beyond line/bar series, grid, tooltip
 * (which brings its axis pointer along), legend and markLine gets its module
 * registered here in the same change.
 */
echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

export { echarts };
