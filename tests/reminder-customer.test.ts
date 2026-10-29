import assert from 'node:assert/strict';
import { reminderCustomer } from '../app/reminder-customer';
const ownCustomers=[{id:42,name:'Own customer'},{id:43,name:'Second customer'}];
assert.deepEqual(reminderCustomer('?customer=42',ownCustomers),{requested:true,customer:ownCustomers[0]});
assert.deepEqual(reminderCustomer('?other=1',ownCustomers),{requested:false,customer:null});
for(const search of ['?customer=999','?customer=','?customer=-1','?customer=4.2','?customer=42junk','?customer=42&customer=43','?customer=9007199254740992']) {
 assert.deepEqual(reminderCustomer(search,ownCustomers),{requested:true,customer:null});
}
assert.equal(reminderCustomer('?customer=42',[]).customer,null);
console.log('Reminder customer selection passed: owned target, missing/deleted/foreign target, malformed and duplicate IDs.');
