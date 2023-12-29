/** GUID generator
 * @internal
 * @link http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
 * @returns Fully valid GUID
*/
export const createGUID = () : string => s4()+s4()+'-'+s4()+'-'+s4()+'-'+s4()+'-'+s4()+s4()+s4();

/** Internal random string generator for GUID */
const s4 = () : string => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
