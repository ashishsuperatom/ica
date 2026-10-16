import { jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
export function UnsettledTrips(props) {
    const [open, setOpen] = useState(false);
    return _jsxs("section", { onClick: () => setOpen(!open), children: [props.count, " unsettled trips", open ? ' (open)' : ''] });
}
