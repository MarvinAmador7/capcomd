import React from "react";
import type { GraphNode } from "../types/graph";

interface NodeDetailsPanelProps {
  node: GraphNode | null;
  onClose: () => void;
}

export function NodeDetailsPanel({ node, onClose }: NodeDetailsPanelProps) {
  if (!node) return null;

  return (
    <div className="node-details-panel">
      <div className="panel-header">
        <h3>{node.data.label}</h3>
        <button onClick={onClose} className="close-button">
          ×
        </button>
      </div>

      <div className="panel-content">
        <section>
          <h4>Type</h4>
          <div className="detail-value">{node.type}</div>
        </section>

        {node.data.state && (
          <section>
            <h4>State</h4>
            <div
              className="state-badge"
              style={{
                background: node.style?.background,
                borderColor: node.style?.borderColor,
              }}
            >
              {node.data.state}
            </div>
          </section>
        )}

        {node.data.epoch !== undefined && (
          <section>
            <h4>Epoch</h4>
            <div className="detail-value">{node.data.epoch}</div>
          </section>
        )}

        {node.data.context && Object.keys(node.data.context).length > 0 && (
          <section>
            <h4>Context</h4>
            <pre className="context-json">
              {JSON.stringify(node.data.context, null, 2)}
            </pre>
          </section>
        )}

        {node.data.budget && (
          <section>
            <h4>Budget</h4>
            <div className="budget-bar">
              <div
                className="budget-used"
                style={{
                  width: `${(node.data.budget.spent / node.data.budget.maxCost) * 100}%`,
                }}
              />
            </div>
            <div className="detail-value">
              ${node.data.budget.spent.toFixed(4)} / ${node.data.budget.maxCost.toFixed(2)}
            </div>
          </section>
        )}

        {node.data.events && node.data.events.length > 0 && (
          <section>
            <h4>Recent Events ({node.data.events.length})</h4>
            <div className="events-list">
              {node.data.events.slice(-5).reverse().map((event, i) => (
                <div key={i} className="event-item">
                  <div className="event-type">{event.event.type}</div>
                  <div className="event-time">
                    {new Date(event.at).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
