export type LabelValues = Record<string, string>;
interface Renderable {
    readonly name: string;
    render(): string;
}
export declare class Counter implements Renderable {
    readonly name: string;
    private readonly help;
    private readonly labelNames;
    private readonly series;
    constructor(name: string, help: string, labelNames?: readonly string[]);
    inc(labels?: LabelValues, value?: number): void;
    render(): string;
}
export declare class Gauge implements Renderable {
    readonly name: string;
    private readonly help;
    private readonly collect;
    constructor(name: string, help: string, collect: () => number);
    render(): string;
}
export declare class Histogram implements Renderable {
    readonly name: string;
    private readonly help;
    private readonly buckets;
    private readonly labelNames;
    constructor(name: string, help: string, buckets: readonly number[], labelNames?: readonly string[]);
    private readonly series;
    observe(labels: LabelValues, value: number): void;
    render(): string;
}
export declare class MetricsRegistry {
    private readonly metrics;
    register<T extends Renderable>(metric: T): T;
    render(): string;
}
export {};
